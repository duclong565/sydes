package main

import (
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
	return NewServer(cfg, rnd, NewMetrics())
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
	s := NewServer(Config{}, stubRand{float: 1.0}, m)
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	s.Routes().ServeHTTP(httptest.NewRecorder(), req)

	mrec := httptest.NewRecorder()
	m.Handler().ServeHTTP(mrec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if !strings.Contains(mrec.Body.String(), `http_requests_total{status="200"} 1`) {
		t.Errorf("metric not recorded:\n%s", mrec.Body.String())
	}
}
