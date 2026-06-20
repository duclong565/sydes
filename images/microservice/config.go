package main

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
)

// Config is the fully-parsed, validated runtime configuration.
type Config struct {
	Port         int
	LatencyMS    int
	JitterMS     int
	ErrorRate    float64
	UpstreamHTTP string
	KafkaBroker  string // e.g. "kafka:9092"
	PublishTopic string // e.g. "order-events"
}

// FromEnv parses configuration from environment variables, applying defaults
// and validating every value. Any invalid value returns an error so the caller
// can fail loud at boot.
func FromEnv() (Config, error) {
	cfg := Config{Port: 8080}

	if v := os.Getenv("PORT"); v != "" {
		p, err := strconv.Atoi(v)
		if err != nil || p < 1 || p > 65535 {
			return Config{}, fmt.Errorf("PORT must be 1-65535, got %q", v)
		}
		cfg.Port = p
	}

	n, err := nonNegInt("LATENCY_MS")
	if err != nil {
		return Config{}, err
	}
	cfg.LatencyMS = n

	n, err = nonNegInt("LATENCY_JITTER_MS")
	if err != nil {
		return Config{}, err
	}
	cfg.JitterMS = n

	if v := os.Getenv("ERROR_RATE"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || f < 0 || f > 1 {
			return Config{}, fmt.Errorf("ERROR_RATE must be 0.0-1.0, got %q", v)
		}
		cfg.ErrorRate = f
	}

	if v := os.Getenv("UPSTREAM_HTTP"); v != "" {
		u, err := url.ParseRequestURI(v)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return Config{}, fmt.Errorf("UPSTREAM_HTTP must be a valid URL, got %q", v)
		}
		cfg.UpstreamHTTP = v
	}

	cfg.KafkaBroker = os.Getenv("KAFKA_BROKER")
	cfg.PublishTopic = os.Getenv("PUBLISH_TOPIC")
	if cfg.PublishTopic != "" && cfg.KafkaBroker == "" {
		return Config{}, fmt.Errorf("PUBLISH_TOPIC set but KAFKA_BROKER is empty")
	}

	return cfg, nil
}

func nonNegInt(key string) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s must be a non-negative integer, got %q", key, v)
	}
	return n, nil
}
