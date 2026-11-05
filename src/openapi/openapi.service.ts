import { Injectable } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ApplicationConfig, HttpAdapterHost, ModulesContainer } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument, serializeOpenApiDocument } from './openapi-document';

/**
 * The OpenAPI document of `/api/v1`, built once per process, on the first ask,
 * and kept as the text it is served as.
 *
 * Built lazily because the routing table is complete only once every module
 * has been wired, and a document built at construction would miss the ones
 * wired after this one. It is the same for every caller and holds no person's
 * data (the roles that may call a route, never who), so one copy serves all.
 *
 * @nestjs/swagger scans a running application: its module container, its
 * configuration (the global prefix, versioning) and its HTTP adapter. A
 * provider is handed those three, each the framework's own injectable, and no
 * `INestApplication`, so the scanner is given them in the shape it reads them
 * in. That shape is the library's, which package.json pins to one version; a
 * release that reads more fails the first request, and the test that builds
 * the document says so before then.
 */
@Injectable()
export class OpenApiService {
  private built: { document: OpenAPIObject; text: string } | undefined;

  constructor(
    private readonly modules: ModulesContainer,
    private readonly config: ApplicationConfig,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  /** The document, built on first use. */
  document(): OpenAPIObject {
    return this.build().document;
  }

  /** The document as served: the same bytes on every call. */
  text(): string {
    return this.build().text;
  }

  private build(): { document: OpenAPIObject; text: string } {
    if (!this.built) {
      const application = {
        container: { getModules: () => this.modules },
        config: this.config,
        getHttpAdapter: () => this.adapterHost.httpAdapter,
      } as unknown as INestApplication;
      const document = buildOpenApiDocument(application, this.modules);
      this.built = { document, text: serializeOpenApiDocument(document) };
    }
    return this.built;
  }
}
