FROM golang:1.25-alpine AS build

WORKDIR /app
COPY . .

RUN go build -mod=mod -v -o /chaincode .

FROM alpine:latest
COPY --from=build /chaincode /chaincode

EXPOSE 7052
CMD ["/chaincode"]
