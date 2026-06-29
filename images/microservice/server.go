package main

import (
	"context"
	"encoding/json"
	"fmt"
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

// Publisher publishes one event per successful request when configured.
// Injected so tests can use a fake.
type Publisher interface {
	Publish(ctx context.Context, value []byte) error
}

// Server wires config, randomness, metrics, and an upstream HTTP client into the
// request handlers.
type Server struct {
	cfg       Config
	rand      RandSource
	metrics   *Metrics
	client    *http.Client
	publisher Publisher
}

// NewServer constructs a Server with a 2s upstream timeout.
func NewServer(cfg Config, rnd RandSource, metrics *Metrics, publisher Publisher) *Server {
	return &Server{
		cfg:       cfg,
		rand:      rnd,
		metrics:   metrics,
		client:    &http.Client{Timeout: 2 * time.Second},
		publisher: publisher,
	}
}

// Routes returns the HTTP handler. Uses Go 1.22+ method patterns.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /", s.handleRoot)
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.Handle("GET /metrics", s.metrics.Handler())
	return mux
}

// delayMs is the simulated processing time: base latency + jitter + per-KB body cost.
func delayMs(cfg Config, bytes int64, jitter int) float64 {
	return float64(cfg.LatencyMS) + float64(jitter) + float64(bytes)/1024.0*cfg.MsPerKb
}

func (s *Server) handleRoot(w http.ResponseWriter, r *http.Request) {
	s.metrics.InFlight.Inc()
	defer s.metrics.InFlight.Dec()

	start := time.Now()
	defer func() { s.metrics.Duration.Observe(time.Since(start).Seconds()) }()

	n, _ := io.Copy(io.Discard, r.Body)

	jitter := 0
	if s.cfg.JitterMS > 0 {
		jitter = s.rand.Intn(s.cfg.JitterMS + 1)
	}
	time.Sleep(time.Duration(delayMs(s.cfg, n, jitter) * float64(time.Millisecond)))

	if s.rand.Float64() < s.cfg.ErrorRate {
		s.respond(w, http.StatusInternalServerError, map[string]string{"error": "injected"})
		return
	}

	if s.cfg.UpstreamHTTP != "" {
		// Body intentionally dropped — this is a traffic simulator, not a proxy.
		resp, err := s.client.Post(s.cfg.UpstreamHTTP, "application/json", http.NoBody)
		if err != nil || resp.StatusCode >= 500 {
			if resp != nil {
				resp.Body.Close()
			}
			s.respond(w, http.StatusBadGateway, map[string]string{"error": "upstream"})
			return
		}
		resp.Body.Close()
	}

	if s.publisher != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		payload := []byte(fmt.Sprintf(`{"ts":%d}`, time.Now().UnixMilli()))
		if err := s.publisher.Publish(ctx, payload); err != nil {
			s.respond(w, http.StatusServiceUnavailable, map[string]string{"error": "publish"})
			return
		}
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
