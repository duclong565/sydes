package main

import (
	"encoding/json"
	"net/http"
	"time"
)

// RandSource is the minimal randomness surface the handler needs. Injected so
// tests can make latency and error rolls deterministic.
type RandSource interface {
	Float64() float64
	Intn(n int) int
}

// Server wires config, randomness, metrics, and an upstream HTTP client into the
// request handlers.
type Server struct {
	cfg     Config
	rand    RandSource
	metrics *Metrics
	client  *http.Client
}

// NewServer constructs a Server with a 2s upstream timeout.
func NewServer(cfg Config, rnd RandSource, metrics *Metrics) *Server {
	return &Server{
		cfg:     cfg,
		rand:    rnd,
		metrics: metrics,
		client:  &http.Client{Timeout: 2 * time.Second},
	}
}

// Routes returns the HTTP handler. Uses Go 1.22 method patterns.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.Handle("GET /metrics", s.metrics.Handler())
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
