package main

import (
	"context"
	"log"
	"time"
)

// RandSource is the minimal randomness surface. Injected for deterministic tests.
type RandSource interface {
	Float64() float64
	Intn(n int) int
}

// Worker consumes messages and simulates processing work.
type Worker struct {
	cfg      Config
	rand     RandSource
	metrics  *Metrics
	consumer Consumer
	sink     Sink // nil when no DB_URL configured
}

func NewWorker(cfg Config, rnd RandSource, metrics *Metrics, consumer Consumer, sink Sink) *Worker {
	return &Worker{cfg: cfg, rand: rnd, metrics: metrics, consumer: consumer, sink: sink}
}

// Run consumes until the context is cancelled.
func (w *Worker) Run(ctx context.Context) {
	var count int
	for {
		val, err := w.consumer.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return // shutdown
			}
			continue // transient read error: skip and retry
		}
		w.process(ctx, val)
		count++
		log.Printf("consumed %d", count)
	}
}

func (w *Worker) process(ctx context.Context, val []byte) {
	w.metrics.InFlight.Inc()
	defer w.metrics.InFlight.Dec()
	start := time.Now()
	defer func() { w.metrics.Duration.Observe(time.Since(start).Seconds()) }()

	delay := w.cfg.LatencyMS
	if w.cfg.JitterMS > 0 {
		delay += w.rand.Intn(w.cfg.JitterMS + 1)
	}
	time.Sleep(time.Duration(delay) * time.Millisecond)

	if w.rand.Float64() < w.cfg.ErrorRate {
		w.metrics.Consumed.WithLabelValues("error").Inc()
		return
	}

	if w.sink != nil {
		if err := w.sink.Write(ctx, val); err != nil {
			w.metrics.DBWrites.WithLabelValues("error").Inc()
			log.Printf("db write failed: %v", err)
		} else {
			w.metrics.DBWrites.WithLabelValues("ok").Inc()
		}
	}

	w.metrics.Consumed.WithLabelValues("ok").Inc()
}
