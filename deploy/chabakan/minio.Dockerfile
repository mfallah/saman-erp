# MinIO on Chabakan as a plain Docker service.
# Use this when the managed "Minio" ready-app is unavailable in the panel.
# Deploy: Docker service -> "I want my own Dockerfile" -> this file content,
# ports 9000 (S3 API) and 9001 (console), disk mounted at /data.
FROM minio/minio:latest

ENV MINIO_ROOT_USER=CHANGE_ME_ACCESS_KEY
ENV MINIO_ROOT_PASSWORD=CHANGE_ME_SECRET_KEY

EXPOSE 9000 9001

CMD ["server", "/data", "--console-address", ":9001"]
