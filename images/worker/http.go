package main

import (
	"encoding/json"
	"net/http"
)

// Server serves the worker's /health and /metrics endpoints.
type Server struct {
	metrics *Metrics
}

func NewServer(metrics *Metrics) *Server {
	return &Server{metrics: metrics}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("GET /metrics", s.metrics.Handler())
	return mux
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
