package main

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestIsBenignConcurrentCreate(t *testing.T) {
	// SQLSTATE 23505 is the catalog unique-violation two workers hit when they race
	// `CREATE TABLE IF NOT EXISTS` against the same Postgres — the table now exists, benign.
	if !isBenignConcurrentCreate(&pgconn.PgError{Code: "23505"}) {
		t.Fatal("23505 should be treated as a benign concurrent create")
	}
	// A different pg error (e.g. undefined_table) must still be fatal.
	if isBenignConcurrentCreate(&pgconn.PgError{Code: "42P01"}) {
		t.Fatal("a non-23505 pg error must not be treated as benign")
	}
	// A non-pg error must still be fatal.
	if isBenignConcurrentCreate(errors.New("connection refused")) {
		t.Fatal("a non-pg error must not be treated as benign")
	}
	// nil is not a benign-create signal.
	if isBenignConcurrentCreate(nil) {
		t.Fatal("nil must not be treated as benign")
	}
}
