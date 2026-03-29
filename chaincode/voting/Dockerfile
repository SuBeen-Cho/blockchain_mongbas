FROM golang:1.21-alpine AS build

WORKDIR /app
COPY . .

RUN go build -v -o /chaincode .

FROM alpine:latest
COPY --from=build /chaincode /chaincode

EXPOSE 7052
CMD ["/chaincode"]
