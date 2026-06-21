package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics holds the worker's Prometheus collectors on a private registry.
type Metrics struct {
	reg      *prometheus.Registry
	Consumed *prometheus.CounterVec
	Duration prometheus.Histogram
	InFlight prometheus.Gauge
	DBWrites *prometheus.CounterVec
}

func NewMetrics() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		reg: reg,
		Consumed: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "messages_consumed_total",
			Help: "Total messages consumed by processing status.",
		}, []string{"status"}),
		Duration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "processing_duration_seconds",
			Help:    "Message processing duration in seconds.",
			Buckets: prometheus.DefBuckets,
		}),
		InFlight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "in_flight",
			Help: "Number of in-flight message processings.",
		}),
		DBWrites: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "db_writes_total",
			Help: "Total Postgres write attempts by status.",
		}, []string{"status"}),
	}
	reg.MustRegister(m.Consumed, m.Duration, m.InFlight, m.DBWrites)
	reg.MustRegister(collectors.NewGoCollector())
	reg.MustRegister(collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	return m
}

func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.reg, promhttp.HandlerOpts{})
}
