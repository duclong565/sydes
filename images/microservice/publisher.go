package main

import (
	"context"
	"time"

	"github.com/segmentio/kafka-go"
)

// KafkaPublisher publishes messages to a topic via segmentio/kafka-go.
type KafkaPublisher struct {
	w *kafka.Writer
}

func NewKafkaPublisher(broker, topic string) *KafkaPublisher {
	return &KafkaPublisher{w: &kafka.Writer{
		Addr:         kafka.TCP(broker),
		Topic:        topic,
		Balancer:     &kafka.LeastBytes{},
		WriteTimeout: 2 * time.Second,
		RequiredAcks: kafka.RequireOne,
	}}
}

func (p *KafkaPublisher) Publish(ctx context.Context, value []byte) error {
	return p.w.WriteMessages(ctx, kafka.Message{Value: value})
}

func (p *KafkaPublisher) Close() error {
	return p.w.Close()
}
