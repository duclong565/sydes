# --- build stage ---
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /worker .

# --- runtime stage ---
FROM scratch
COPY --from=build /worker /worker
EXPOSE 8080
USER 10001:10001
ENTRYPOINT ["/worker"]
