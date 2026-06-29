package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
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
	// `CREATE TABLE IF NOT EXISTS` is not concurrency-safe: when several workers share
	// one Postgres (N workers consuming N partitions), two can pass the existence check
	// then race the catalog insert, and one gets SQLSTATE 23505. The table exists now —
	// treat that as success rather than crashing the worker.
	if _, err = pool.Exec(ctx, createEventsTable); err != nil && !isBenignConcurrentCreate(err) {
		pool.Close()
		return nil, fmt.Errorf("create events table: %w", err)
	}
	return &PgxSink{pool: pool}, nil
}

// isBenignConcurrentCreate reports whether a CREATE TABLE error is the known Postgres
// race where a concurrent session created the table first (SQLSTATE 23505, a unique
// violation on the system catalog). Such errors mean the table now exists — safe to ignore.
func isBenignConcurrentCreate(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func (s *PgxSink) Write(ctx context.Context, payload []byte) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO events(payload) VALUES($1)`, payload)
	return err
}

func (s *PgxSink) Close() error {
	s.pool.Close()
	return nil
}
