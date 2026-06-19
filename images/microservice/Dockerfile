# --- build stage ---
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /microservice .

# --- runtime stage ---
FROM scratch
COPY --from=build /microservice /microservice
EXPOSE 8080
USER 10001:10001
ENTRYPOINT ["/microservice"]
