FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS build

WORKDIR /app
COPY . .

RUN CGO_ENABLED=0 go build -mod=vendor -trimpath -ldflags='-s -w' -o /chaincode .

FROM scratch
COPY --from=build /chaincode /chaincode

USER 65532:65532
EXPOSE 7052
ENTRYPOINT ["/chaincode"]
