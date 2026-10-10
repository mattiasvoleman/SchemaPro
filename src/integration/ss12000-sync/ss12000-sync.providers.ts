import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Ss12000Config } from '../../config/configuration';
import type { ClientOptions } from './client';
import { sendOutbound } from './outbound';
import { SecretBox } from './secret-box';

/**
 * How the sync reaches a source: the outbound policy (loopback only under
 * NODE_ENV=test with SS12000_ALLOW_INSECURE_LOCAL=1) and the client's
 * timings. A provider of its own so the e2e suite can hand in the mock
 * provider's test CA and short retry waits — the only things it changes —
 * without touching the code under test.
 */
@Injectable()
export class Ss12000Outbound {
  constructor(@Optional() private readonly config?: ConfigService) {}

  clientOptions(): ClientOptions {
    return {
      policy: { allowLoopback: this.config?.get<Ss12000Config>('ss12000')?.allowInsecureLocal === true },
      send: sendOutbound,
    };
  }
}

/** The credentials' box, keyed from INTEGRATION_SECRETS_KEY (and _PREVIOUS). */
@Injectable()
export class Ss12000Secrets {
  readonly box: SecretBox;

  constructor(@Optional() config?: ConfigService) {
    const settings = config?.get<Ss12000Config>('ss12000');
    this.box = new SecretBox(settings?.secretsKey, settings?.secretsKeyPrevious);
  }
}
