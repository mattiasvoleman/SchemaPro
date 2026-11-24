import { gzipSync, deflateSync } from 'node:zlib';
import { BadRequestException, Body, Controller, Module, Post, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { configureBodyParsers, jsonParseRefusal, MAX_BODY_SIZE } from './http-defaults';

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
    const use = jest.fn();
    configureBodyParsers({ useBodyParser, use } as unknown as NestExpressApplication);

    expect(useBodyParser).toHaveBeenCalledWith('json', { limit: MAX_BODY_SIZE, inflate: false });
    expect(useBodyParser).toHaveBeenCalledWith('urlencoded', {
      limit: MAX_BODY_SIZE,
      extended: true,
      inflate: false,
    });
    // The error middleware comes after both parsers, or it would not see their errors.
    expect(use).toHaveBeenCalledWith(jsonParseRefusal);
    expect(use.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...useBodyParser.mock.invocationCallOrder));
  });

  describe('jsonParseRefusal', () => {
    it('passes a body-parser syntax error on as a 400 with the code a page words, and Node\'s sentence is gone', () => {
      const next = jest.fn();
      const parse = Object.assign(new SyntaxError('Unexpected end of JSON input'), { type: 'entity.parse.failed', status: 400 });

      jsonParseRefusal(parse, {}, {}, next);

      const [refusal] = next.mock.calls[0] as [BadRequestException];
      expect(refusal).toBeInstanceOf(BadRequestException);
      expect(refusal.getResponse()).toEqual({ message: 'The request body is not valid JSON.', code: 'REQUEST_BODY_NOT_JSON' });
    });

    it.each([
      ['an error of another kind', Object.assign(new Error('too large'), { type: 'entity.too.large' })],
      ['a syntax error with no type (nothing body-parser threw)', new SyntaxError('bad')],
      ['something that is not an error', 'boom'],
      ['nothing', undefined],
    ])('passes %s on untouched', (_name, error) => {
      const next = jest.fn();
      jsonParseRefusal(error, {}, {}, next);
      expect(next).toHaveBeenCalledWith(error);
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

    it('answers an invalid JSON body 400 with the code, not with Node\'s sentence', async () => {
      const res = await request(app.getHttpServer())
        .post('/echo')
        .set('Content-Type', 'application/json')
        .send('{"rows": [');

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ message: 'The request body is not valid JSON.', code: 'REQUEST_BODY_NOT_JSON' });
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
