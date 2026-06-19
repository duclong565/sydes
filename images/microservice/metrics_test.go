package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetrics_ExposesCounters(t *testing.T) {
	m := NewMetrics()
	m.Requests.WithLabelValues("200").Inc()
	m.Requests.WithLabelValues("200").Inc()
	m.Requests.WithLabelValues("500").Inc()

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, `http_requests_total{status="200"} 2`) {
		t.Errorf("missing 200 counter:\n%s", body)
	}
	if !strings.Contains(body, `http_requests_total{status="500"} 1`) {
		t.Errorf("missing 500 counter:\n%s", body)
	}
}
