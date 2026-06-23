import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import type { AiEngineConfig } from '../config/configuration';
import { OptimizationController } from './optimization.controller';
import { OptimizationProxyService } from './optimization-proxy.service';

@Module({
  imports: [
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const ai = configService.getOrThrow<AiEngineConfig>('aiEngine');
        return {
          baseURL: ai.baseUrl,
          timeout: ai.timeoutMs,
          headers: {
            'Accept': 'application/json',
          },
        };
      },
    }),
  ],
  controllers: [OptimizationController],
  providers: [OptimizationProxyService],
})
export class OptimizationModule {}
