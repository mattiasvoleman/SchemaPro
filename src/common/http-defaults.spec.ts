import { gzipSync, deflateSync } from 'node:zlib';
import { Body, Controller, Module, Post, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { configureBodyParsers, MAX_BODY_SIZE } from './http-defaults';

@Controller('echo')
class EchoController {
  @Post()
  echo(@Body() body: unknown): { got: unknown } {
    return { got: body };
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

describe('configureBodyParsers', () => {
  it('reads JSON and form bodies up to the limit and never inflates one', () => {
    const useBodyParser = jest.fn();
    configureBodyParsers({ useBodyParser } as unknown as NestExpressApplication);

    expect(useBodyParser).toHaveBeenCalledWith('json', { limit: MAX_BODY_SIZE, inflate: false });
    expect(useBodyParser).toHaveBeenCalledWith('urlencoded', {
      limit: MAX_BODY_SIZE,
      extended: true,
      inflate: false,
    });
  });

  describe('over HTTP', () => {
    let app: INestApplication;

    beforeAll(async () => {
      const nest = await NestFactory.create<NestExpressApplication>(EchoModule, { logger: false });
      configureBodyParsers(nest);
      await nest.init();
      app = nest;
    });

    afterAll(async () => {
      await app.close();
    });

    it('reads a plain JSON body', async () => {
      const res = await request(app.getHttpServer())
        .post('/echo')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ a: 1 }));

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ got: { a: 1 } });
    });

    // GHSA-27r3-jxmh-p828 lives in body-parser's inflate path: a compressed
    // body is refused before anything decompresses it.
    it.each([
      ['gzip', gzipSync(Buffer.from(JSON.stringify({ a: 1 })))],
      ['deflate', deflateSync(Buffer.from(JSON.stringify({ a: 1 })))],
    ])('refuses a %s-encoded JSON body with 415 and never reaches the handler', async (encoding, payload) => {
      const res = await request(app.getHttpServer())
        .post('/echo')
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', encoding)
        .send(payload);

      expect(res.status).toBe(415);
      expect(res.body).not.toHaveProperty('got');
    });

    it('refuses a gzip-encoded form body with 415', async () => {
      const res = await request(app.getHttpServer())
        .post('/echo')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .set('Content-Encoding', 'gzip')
        .send(gzipSync(Buffer.from('a=1')));

      expect(res.status).toBe(415);
    });
  });
});
