package main

import "testing"

func TestFromEnv_Defaults(t *testing.T) {
	for _, k := range []string{"PORT", "LATENCY_MS", "LATENCY_JITTER_MS", "ERROR_RATE", "UPSTREAM_HTTP"} {
		t.Setenv(k, "")
	}
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Port != 8080 {
		t.Errorf("Port = %d, want 8080", cfg.Port)
	}
	if cfg.LatencyMS != 0 || cfg.JitterMS != 0 || cfg.ErrorRate != 0 || cfg.UpstreamHTTP != "" {
		t.Errorf("non-zero defaults: %+v", cfg)
	}
}

func TestFromEnv_Valid(t *testing.T) {
	t.Setenv("PORT", "9000")
	t.Setenv("LATENCY_MS", "20")
	t.Setenv("LATENCY_JITTER_MS", "5")
	t.Setenv("ERROR_RATE", "0.1")
	t.Setenv("UPSTREAM_HTTP", "http://payment:8080/")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Port != 9000 || cfg.LatencyMS != 20 || cfg.JitterMS != 5 ||
		cfg.ErrorRate != 0.1 || cfg.UpstreamHTTP != "http://payment:8080/" {
		t.Errorf("bad config: %+v", cfg)
	}
}

func TestFromEnv_InvalidErrorRate(t *testing.T) {
	t.Setenv("ERROR_RATE", "2.0")
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected error for ERROR_RATE=2.0")
	}
}

func TestFromEnv_InvalidPort(t *testing.T) {
	t.Setenv("PORT", "0")
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected error for PORT=0")
	}
}

func TestFromEnv_InvalidUpstream(t *testing.T) {
	t.Setenv("UPSTREAM_HTTP", "not-a-url")
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected error for malformed UPSTREAM_HTTP")
	}
}

func TestFromEnv_IgnoresUnknown(t *testing.T) {
	t.Setenv("DB_URL", "postgres://x:5432")
	t.Setenv("KAFKA_BROKER", "kafka:9092")
	t.Setenv("PUBLISH_TOPIC", "order-events")
	if _, err := FromEnv(); err != nil {
		t.Fatalf("unknown envs must be ignored: %v", err)
	}
}
