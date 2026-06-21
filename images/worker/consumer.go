package main

import (
	"context"

	"github.com/segmentio/kafka-go"
)

// Consumer reads the next message value from a topic set. Injected so tests can use a fake.
type Consumer interface {
	Read(ctx context.Context) ([]byte, error)
	Close() error
}

// KafkaConsumer is a kafka-go consumer-group reader.
type KafkaConsumer struct {
	r *kafka.Reader
}

func NewKafkaConsumer(broker string, topics []string, groupID string) *KafkaConsumer {
	cfg := kafka.ReaderConfig{
		Brokers:     []string{broker},
		GroupID:     groupID,
		MinBytes:    1,
		MaxBytes:    10e6,
		StartOffset: kafka.FirstOffset, // read from beginning when no committed offset exists
	}
	// Use Topic (single) for the common case; fall back to GroupTopics for multi-topic.
	// Topic+GroupID is better supported across kafka-go versions than GroupTopics.
	if len(topics) == 1 {
		cfg.Topic = topics[0]
	} else {
		cfg.GroupTopics = topics
	}
	return &KafkaConsumer{r: kafka.NewReader(cfg)}
}

// Read returns the next message value, auto-committing within the consumer group.
func (c *KafkaConsumer) Read(ctx context.Context) ([]byte, error) {
	m, err := c.r.ReadMessage(ctx)
	if err != nil {
		return nil, err
	}
	return m.Value, nil
}

func (c *KafkaConsumer) Close() error { return c.r.Close() }
