package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics holds the app's Prometheus collectors and a private registry so tests
// stay isolated from the global default registry.
type Metrics struct {
	reg      *prometheus.Registry
	Requests *prometheus.CounterVec
	Duration prometheus.Histogram
	InFlight prometheus.Gauge
}

// NewMetrics builds and registers all collectors, including Go/process baseline
// metrics.
func NewMetrics() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		reg: reg,
		Requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "Total HTTP requests by response status code.",
		}, []string{"status"}),
		Duration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "http_request_duration_seconds",
			Help:    "HTTP request handler duration in seconds.",
			Buckets: prometheus.DefBuckets,
		}),
		InFlight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "http_in_flight_requests",
			Help: "Number of in-flight HTTP requests.",
		}),
	}
	reg.MustRegister(m.Requests, m.Duration, m.InFlight)
	reg.MustRegister(collectors.NewGoCollector())
	reg.MustRegister(collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	return m
}

// Handler serves the Prometheus exposition format for this registry.
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.reg, promhttp.HandlerOpts{})
}
