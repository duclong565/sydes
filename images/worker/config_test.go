package main

import "testing"

func TestFromEnv_Valid(t *testing.T) {
	t.Setenv("KAFKA_BROKER", "kafka:9092")
	t.Setenv("SUBSCRIBE_TOPICS", "order-events, payment-events")
	t.Setenv("LATENCY_MS", "20")
	t.Setenv("ERROR_RATE", "0.1")
	cfg, err := FromEnv()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.KafkaBroker != "kafka:9092" {
		t.Errorf("broker = %q", cfg.KafkaBroker)
	}
	if len(cfg.SubscribeTopics) != 2 || cfg.SubscribeTopics[0] != "order-events" || cfg.SubscribeTopics[1] != "payment-events" {
		t.Errorf("topics = %v", cfg.SubscribeTopics)
	}
	if cfg.LatencyMS != 20 || cfg.ErrorRate != 0.1 {
		t.Errorf("cfg = %+v", cfg)
	}
}

func TestFromEnv_RequiresTopics(t *testing.T) {
	t.Setenv("KAFKA_BROKER", "kafka:9092")
	t.Setenv("SUBSCRIBE_TOPICS", "")
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected error: SUBSCRIBE_TOPICS required")
	}
}

func TestFromEnv_RequiresBroker(t *testing.T) {
	t.Setenv("KAFKA_BROKER", "")
	t.Setenv("SUBSCRIBE_TOPICS", "order-events")
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected error: KAFKA_BROKER required")
	}
}

func TestFromEnv_InvalidErrorRate(t *testing.T) {
	t.Setenv("KAFKA_BROKER", "kafka:9092")
	t.Setenv("SUBSCRIBE_TOPICS", "x")
	t.Setenv("ERROR_RATE", "2.0")
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected error for ERROR_RATE=2.0")
	}
}

func TestFromEnv_IgnoresDBURL(t *testing.T) {
	t.Setenv("KAFKA_BROKER", "kafka:9092")
	t.Setenv("SUBSCRIBE_TOPICS", "x")
	t.Setenv("DB_URL", "postgres://db:5432")
	if _, err := FromEnv(); err != nil {
		t.Fatalf("DB_URL should be ignored: %v", err)
	}
}
