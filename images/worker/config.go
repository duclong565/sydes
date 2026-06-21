package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config is the fully-parsed, validated runtime configuration.
type Config struct {
	Port            int
	LatencyMS       int
	JitterMS        int
	ErrorRate       float64
	KafkaBroker     string
	SubscribeTopics []string
}

// FromEnv parses + validates configuration, failing loud on any invalid value.
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

	cfg.KafkaBroker = os.Getenv("KAFKA_BROKER")

	for _, t := range strings.Split(os.Getenv("SUBSCRIBE_TOPICS"), ",") {
		if s := strings.TrimSpace(t); s != "" {
			cfg.SubscribeTopics = append(cfg.SubscribeTopics, s)
		}
	}
	if len(cfg.SubscribeTopics) == 0 {
		return Config{}, fmt.Errorf("SUBSCRIBE_TOPICS is required")
	}
	if cfg.KafkaBroker == "" {
		return Config{}, fmt.Errorf("KAFKA_BROKER is required when SUBSCRIBE_TOPICS is set")
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
