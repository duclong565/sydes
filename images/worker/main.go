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
	worker := NewWorker(cfg, rnd, metrics, consumer)

	httpSrv := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      NewServer(metrics).Routes(),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	go func() {
		log.Printf("worker consuming %v via %s (group %s)", cfg.SubscribeTopics, cfg.KafkaBroker, groupID)
		worker.Run(ctx)
	}()
	go func() {
		log.Printf("worker http on :%d", cfg.Port)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http error: %v", err)
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
