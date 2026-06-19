package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
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
	mux.HandleFunc("POST /", s.handleRoot)
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.Handle("GET /metrics", s.metrics.Handler())
	return mux
}

func (s *Server) handleRoot(w http.ResponseWriter, r *http.Request) {
	s.metrics.InFlight.Inc()
	defer s.metrics.InFlight.Dec()

	start := time.Now()
	defer func() { s.metrics.Duration.Observe(time.Since(start).Seconds()) }()

	_, _ = io.Copy(io.Discard, r.Body)

	delay := s.cfg.LatencyMS
	if s.cfg.JitterMS > 0 {
		delay += s.rand.Intn(s.cfg.JitterMS + 1)
	}
	time.Sleep(time.Duration(delay) * time.Millisecond)

	if s.rand.Float64() < s.cfg.ErrorRate {
		s.respond(w, http.StatusInternalServerError, map[string]string{"error": "injected"})
		return
	}

	s.respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// respond records the status counter then writes the JSON body.
func (s *Server) respond(w http.ResponseWriter, status int, body any) {
	s.metrics.Requests.WithLabelValues(strconv.Itoa(status)).Inc()
	writeJSON(w, status, body)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
