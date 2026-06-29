package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// stubRand is a deterministic RandSource for tests.
type stubRand struct {
	float float64
	intn  int
}

func (s stubRand) Float64() float64 { return s.float }
func (s stubRand) Intn(n int) int   { return s.intn }

func newTestServer(cfg Config, rnd RandSource) *Server {
	return NewServer(cfg, rnd, NewMetrics(), nil)
}

func TestHealth(t *testing.T) {
	s := newTestServer(Config{}, stubRand{float: 1})
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("health = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "ok") {
		t.Errorf("body = %q", rec.Body.String())
	}
}

func TestMetricsRouteServed(t *testing.T) {
	s := newTestServer(Config{}, stubRand{float: 1})
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/metrics = %d, want 200", rec.Code)
	}
}

func post(s *Server) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"ping":true}`))
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	return rec
}

func TestRoot_Success(t *testing.T) {
	s := newTestServer(Config{}, stubRand{float: 1.0})
	if rec := post(s); rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
}

func TestRoot_InjectedError(t *testing.T) {
	// Float64()=0.0 < ErrorRate=1.0 → forced error.
	s := newTestServer(Config{ErrorRate: 1.0}, stubRand{float: 0.0})
	if rec := post(s); rec.Code != http.StatusInternalServerError {
		t.Fatalf("got %d, want 500", rec.Code)
	}
}

func TestRoot_NoErrorWhenRateZero(t *testing.T) {
	s := newTestServer(Config{ErrorRate: 0.0}, stubRand{float: 0.0})
	if rec := post(s); rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
}

func TestRoot_Latency(t *testing.T) {
	s := newTestServer(Config{LatencyMS: 50}, stubRand{float: 1.0})
	start := time.Now()
	post(s)
	if elapsed := time.Since(start); elapsed < 50*time.Millisecond {
		t.Errorf("elapsed %v, want >= 50ms", elapsed)
	}
}

func TestRoot_RecordsMetric(t *testing.T) {
	m := NewMetrics()
	s := NewServer(Config{}, stubRand{float: 1.0}, m, nil)
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	s.Routes().ServeHTTP(httptest.NewRecorder(), req)

	mrec := httptest.NewRecorder()
	m.Handler().ServeHTTP(mrec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if !strings.Contains(mrec.Body.String(), `http_requests_total{status="200"} 1`) {
		t.Errorf("metric not recorded:\n%s", mrec.Body.String())
	}
}

func TestRoot_UpstreamHappy(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	s := newTestServer(Config{UpstreamHTTP: upstream.URL}, stubRand{float: 1.0})
	if rec := post(s); rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
}

func TestRoot_UpstreamCascade(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()

	s := newTestServer(Config{UpstreamHTTP: upstream.URL}, stubRand{float: 1.0})
	if rec := post(s); rec.Code != http.StatusBadGateway {
		t.Fatalf("got %d, want 502", rec.Code)
	}
}

func TestRoot_UpstreamDown(t *testing.T) {
	// 127.0.0.1:1 refuses immediately — well under the 2s timeout.
	s := newTestServer(Config{UpstreamHTTP: "http://127.0.0.1:1"}, stubRand{float: 1.0})
	if rec := post(s); rec.Code != http.StatusBadGateway {
		t.Fatalf("got %d, want 502", rec.Code)
	}
}

type fakePublisher struct {
	calls     int
	lastValue []byte
	err       error
}

func (f *fakePublisher) Publish(_ context.Context, value []byte) error {
	f.calls++
	f.lastValue = append([]byte(nil), value...)
	return f.err
}

func TestRoot_PublishesOnSuccess(t *testing.T) {
	pub := &fakePublisher{}
	s := NewServer(Config{}, stubRand{float: 1.0}, NewMetrics(), pub)
	rec := post(s)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
	if pub.calls != 1 {
		t.Fatalf("publisher calls = %d, want 1", pub.calls)
	}
	if !strings.Contains(string(pub.lastValue), `"ts"`) {
		t.Errorf("payload missing ts: %s", pub.lastValue)
	}
}

func TestRoot_PublishFailureReturns503(t *testing.T) {
	pub := &fakePublisher{err: errors.New("broker down")}
	s := NewServer(Config{}, stubRand{float: 1.0}, NewMetrics(), pub)
	if rec := post(s); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d, want 503", rec.Code)
	}
}

func TestRoot_NoPublishOnInjectedError(t *testing.T) {
	pub := &fakePublisher{}
	s := NewServer(Config{ErrorRate: 1.0}, stubRand{float: 0.0}, NewMetrics(), pub)
	if rec := post(s); rec.Code != http.StatusInternalServerError {
		t.Fatalf("got %d, want 500", rec.Code)
	}
	if pub.calls != 0 {
		t.Errorf("publisher should not be called on injected error, got %d", pub.calls)
	}
}

func TestRoot_NoPublishOnUpstreamCascade(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()
	pub := &fakePublisher{}
	s := NewServer(Config{UpstreamHTTP: upstream.URL}, stubRand{float: 1.0}, NewMetrics(), pub)
	if rec := post(s); rec.Code != http.StatusBadGateway {
		t.Fatalf("got %d, want 502", rec.Code)
	}
	if pub.calls != 0 {
		t.Errorf("publisher should not be called on upstream cascade, got %d", pub.calls)
	}
}

func TestDelayMs(t *testing.T) {
	cfg := Config{LatencyMS: 10, MsPerKb: 0.5}
	// 64 KB at 0.5 ms/KB = +32 ms, plus base 10 ms, plus jitter 3 ms = 45 ms
	if got := delayMs(cfg, 64*1024, 3); got != 45 {
		t.Errorf("delayMs = %v, want 45", got)
	}
	// MsPerKb = 0 → body size has no effect (back-compat)
	if got := delayMs(Config{LatencyMS: 10}, 64*1024, 0); got != 10 {
		t.Errorf("delayMs(no msPerKb) = %v, want 10", got)
	}
}
