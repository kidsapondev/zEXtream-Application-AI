import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);

  // Only trust proxy headers (X-Forwarded-For) when explicitly configured with the
  // number of hops in front of the app; 0 means no proxy is trusted, so req.ip stays
  // the raw socket address and can't be spoofed via headers.
  const trustProxy = configService.get<number>('TRUST_PROXY', 0);
  if (trustProxy > 0) {
    app.set('trust proxy', trustProxy);
  }

  app.setGlobalPrefix('api');
  app.use(cookieParser());

  app.enableCors({
    origin: process.env.CORS_ORIGIN,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
