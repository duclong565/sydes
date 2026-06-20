package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os/signal"
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

	var publisher Publisher
	if cfg.PublishTopic != "" {
		kp := NewKafkaPublisher(cfg.KafkaBroker, cfg.PublishTopic)
		defer kp.Close()
		publisher = kp
	}
	srv := NewServer(cfg, rnd, metrics, publisher)

	httpSrv := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      srv.Routes(),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	go func() {
		log.Printf("microservice listening on :%d", cfg.Port)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Print("shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
}
