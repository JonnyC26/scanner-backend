'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { R2_BUCKET } = require('./constants');

function createR2Client(env = process.env) {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function createR2Store({ client, bucket = R2_BUCKET } = {}) {
  const s3 = client || createR2Client();
  return {
    async getObject(key) {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks = [];
        for await (const chunk of out.Body) chunks.push(chunk);
        return Buffer.concat(chunks);
      } catch (err) {
        const status = err.$metadata && err.$metadata.httpStatusCode;
        if (err.name === 'NoSuchKey' || status === 404) return null;
        throw err;
      }
    },
    async putObject({ key, body, contentType, cacheControl }) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
      }));
    },
  };
}

module.exports = { createR2Client, createR2Store };
