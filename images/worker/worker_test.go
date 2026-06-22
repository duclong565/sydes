package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type stubRand struct {
	float float64
	intn  int
}

func (s stubRand) Float64() float64 { return s.float }
func (s stubRand) Intn(n int) int   { return s.intn }

// fakeConsumer returns queued values, then cancels the run context and signals done.
type fakeConsumer struct {
	values [][]byte
	i      int
	cancel context.CancelFunc
}

func (f *fakeConsumer) Read(_ context.Context) ([]byte, error) {
	if f.i >= len(f.values) {
		f.cancel()
		return nil, context.Canceled
	}
	v := f.values[f.i]
	f.i++
	return v, nil
}
func (f *fakeConsumer) Close() error { return nil }

// fakeSink records writes; if err is set, Write returns it instead of recording.
type fakeSink struct {
	writes [][]byte
	err    error
}

func (f *fakeSink) Write(_ context.Context, p []byte) error {
	if f.err != nil {
		return f.err
	}
	f.writes = append(f.writes, p)
	return nil
}
func (f *fakeSink) Close() error { return nil }

func scrape(m *Metrics) string {
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	return rec.Body.String()
}

func TestWorker_ConsumesAllMessages(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &fakeConsumer{values: [][]byte{[]byte("a"), []byte("b"), []byte("c")}, cancel: cancel}
	NewWorker(Config{}, stubRand{float: 1.0}, m, fc, nil).Run(ctx)
	if !strings.Contains(scrape(m), `messages_consumed_total{status="ok"} 3`) {
		t.Errorf("expected 3 ok:\n%s", scrape(m))
	}
}

func TestWorker_CountsErrors(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &fakeConsumer{values: [][]byte{[]byte("a"), []byte("b")}, cancel: cancel}
	NewWorker(Config{ErrorRate: 1.0}, stubRand{float: 0.0}, m, fc, nil).Run(ctx)
	body := scrape(m)
	if !strings.Contains(body, `messages_consumed_total{status="error"} 2`) {
		t.Errorf("expected 2 error:\n%s", body)
	}
	if strings.Contains(body, `status="ok"`) {
		t.Errorf("should be no ok series:\n%s", body)
	}
}

func TestWorker_WritesOnOkPath(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &fakeConsumer{values: [][]byte{[]byte("a"), []byte("b"), []byte("c")}, cancel: cancel}
	sink := &fakeSink{}
	NewWorker(Config{}, stubRand{float: 1.0}, m, fc, sink).Run(ctx)
	if len(sink.writes) != 3 {
		t.Errorf("expected 3 writes, got %d", len(sink.writes))
	}
	if !strings.Contains(scrape(m), `db_writes_total{status="ok"} 3`) {
		t.Errorf("expected 3 ok writes:\n%s", scrape(m))
	}
}

func TestWorker_SkipsWriteOnSimulatedError(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &fakeConsumer{values: [][]byte{[]byte("a"), []byte("b")}, cancel: cancel}
	sink := &fakeSink{}
	NewWorker(Config{ErrorRate: 1.0}, stubRand{float: 0.0}, m, fc, sink).Run(ctx)
	if len(sink.writes) != 0 {
		t.Errorf("expected no writes on error path, got %d", len(sink.writes))
	}
	if strings.Contains(scrape(m), `db_writes_total`) {
		t.Errorf("expected no db_writes series:\n%s", scrape(m))
	}
}

func TestWorker_CountsWriteErrorsAndContinues(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &fakeConsumer{values: [][]byte{[]byte("a"), []byte("b")}, cancel: cancel}
	sink := &fakeSink{err: errors.New("boom")}
	NewWorker(Config{}, stubRand{float: 1.0}, m, fc, sink).Run(ctx)
	body := scrape(m)
	if !strings.Contains(body, `db_writes_total{status="error"} 2`) {
		t.Errorf("expected 2 error writes:\n%s", body)
	}
	if !strings.Contains(body, `messages_consumed_total{status="ok"} 2`) {
		t.Errorf("worker should keep consuming after write errors:\n%s", body)
	}
}

func TestWorker_NilSinkIsNoOp(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &fakeConsumer{values: [][]byte{[]byte("a"), []byte("b")}, cancel: cancel}
	NewWorker(Config{}, stubRand{float: 1.0}, m, fc, nil).Run(ctx)
	body := scrape(m)
	if strings.Contains(body, `db_writes_total`) {
		t.Errorf("nil sink should write nothing:\n%s", body)
	}
	if !strings.Contains(body, `messages_consumed_total{status="ok"} 2`) {
		t.Errorf("expected 2 ok consumed:\n%s", body)
	}
}

// flakyConsumer returns one transient (non-ctx) error, then its queued values, then cancels.
type flakyConsumer struct {
	erroredOnce bool
	values      [][]byte
	i           int
	cancel      context.CancelFunc
}

func (f *flakyConsumer) Read(_ context.Context) ([]byte, error) {
	if !f.erroredOnce {
		f.erroredOnce = true
		return nil, errors.New("transient read error")
	}
	if f.i >= len(f.values) {
		f.cancel()
		return nil, context.Canceled
	}
	v := f.values[f.i]
	f.i++
	return v, nil
}
func (f *flakyConsumer) Close() error { return nil }

func TestWorker_SurvivesTransientReadError(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &flakyConsumer{values: [][]byte{[]byte("a")}, cancel: cancel}
	w := NewWorker(Config{}, stubRand{float: 1.0}, m, fc, nil)
	w.readBackoff = 0 // no real delay in the test
	w.Run(ctx)
	if !strings.Contains(scrape(m), `messages_consumed_total{status="ok"} 1`) {
		t.Errorf("loop should survive a transient read error and process the next message:\n%s", scrape(m))
	}
}
