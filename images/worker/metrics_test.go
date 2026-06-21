package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetrics_ExposesConsumed(t *testing.T) {
	m := NewMetrics()
	m.Consumed.WithLabelValues("ok").Inc()
	m.Consumed.WithLabelValues("ok").Inc()
	m.Consumed.WithLabelValues("error").Inc()

	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := rec.Body.String()
	if !strings.Contains(body, `messages_consumed_total{status="ok"} 2`) {
		t.Errorf("missing ok counter:\n%s", body)
	}
	if !strings.Contains(body, `messages_consumed_total{status="error"} 1`) {
		t.Errorf("missing error counter:\n%s", body)
	}
}
