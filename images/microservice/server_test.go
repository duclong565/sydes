package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
