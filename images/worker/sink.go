package main

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Sink persists a processed message payload. Injected so tests can use a fake.
type Sink interface {
	Write(ctx context.Context, payload []byte) error
	Close() error
}

const createEventsTable = `CREATE TABLE IF NOT EXISTS events (` +
	`id bigserial primary key, payload text, ts timestamptz default now())`

// PgxSink writes payloads to Postgres via a pgx connection pool.
type PgxSink struct {
	pool *pgxpool.Pool
}

// NewPgxSink connects to Postgres (retrying until ready or ~30s), then ensures the events table exists.
func NewPgxSink(ctx context.Context, dsn string) (*PgxSink, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("pgxpool config: %w", err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		if err = pool.Ping(ctx); err == nil {
			break
		}
		if ctx.Err() != nil {
			pool.Close()
			return nil, ctx.Err()
		}
		if time.Now().After(deadline) {
			pool.Close()
			return nil, fmt.Errorf("postgres not ready after 30s: %w", err)
		}
		time.Sleep(time.Second)
	}
	if _, err = pool.Exec(ctx, createEventsTable); err != nil {
		pool.Close()
		return nil, fmt.Errorf("create events table: %w", err)
	}
	return &PgxSink{pool: pool}, nil
}

func (s *PgxSink) Write(ctx context.Context, payload []byte) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO events(payload) VALUES($1)`, payload)
	return err
}

func (s *PgxSink) Close() error {
	s.pool.Close()
	return nil
}
