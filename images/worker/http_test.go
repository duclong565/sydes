package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealth(t *testing.T) {
	s := NewServer(NewMetrics())
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "ok") {
		t.Errorf("body = %q", rec.Body.String())
	}
}

func TestMetricsRouteServed(t *testing.T) {
	s := NewServer(NewMetrics())
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/metrics = %d, want 200", rec.Code)
	}
}
