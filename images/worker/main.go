package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	cfg, err := FromEnv()
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	metrics := NewMetrics()
	rnd := rand.New(rand.NewSource(time.Now().UnixNano()))
	groupID := "sds-" + strings.Join(cfg.SubscribeTopics, "-")
	consumer := NewKafkaConsumer(cfg.KafkaBroker, cfg.SubscribeTopics, groupID)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	var sink Sink
	if cfg.DBURL != "" {
		pgSink, err := NewPgxSink(ctx, cfg.DBURL)
		if err != nil {
			log.Fatalf("db sink: %v", err)
		}
		defer pgSink.Close()
		sink = pgSink
		log.Printf("worker persisting to postgres")
	}

	worker := NewWorker(cfg, rnd, metrics, consumer, sink)

	httpSrv := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      NewServer(metrics).Routes(),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	go func() {
		log.Printf("worker consuming %v via %s (group %s)", cfg.SubscribeTopics, cfg.KafkaBroker, groupID)
		worker.Run(ctx)
	}()
	go func() {
		log.Printf("worker http on :%d", cfg.Port)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("http server error: %v", err)
			stop() // cancel ctx -> graceful shutdown path runs
		}
	}()

	<-ctx.Done()
	log.Print("shutting down")
	_ = consumer.Close()
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
}
