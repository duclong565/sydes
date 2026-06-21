package main

import (
	"context"
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

func scrape(m *Metrics) string {
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	return rec.Body.String()
}

func TestWorker_ConsumesAllMessages(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &fakeConsumer{values: [][]byte{[]byte("a"), []byte("b"), []byte("c")}, cancel: cancel}
	NewWorker(Config{}, stubRand{float: 1.0}, m, fc).Run(ctx)
	if !strings.Contains(scrape(m), `messages_consumed_total{status="ok"} 3`) {
		t.Errorf("expected 3 ok:\n%s", scrape(m))
	}
}

func TestWorker_CountsErrors(t *testing.T) {
	m := NewMetrics()
	ctx, cancel := context.WithCancel(context.Background())
	fc := &fakeConsumer{values: [][]byte{[]byte("a"), []byte("b")}, cancel: cancel}
	NewWorker(Config{ErrorRate: 1.0}, stubRand{float: 0.0}, m, fc).Run(ctx)
	body := scrape(m)
	if !strings.Contains(body, `messages_consumed_total{status="error"} 2`) {
		t.Errorf("expected 2 error:\n%s", body)
	}
	if strings.Contains(body, `status="ok"`) {
		t.Errorf("should be no ok series:\n%s", body)
	}
}
