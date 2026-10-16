import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { type Request, type Response } from 'express';
import { type Observable } from 'rxjs';
import { map } from 'rxjs/operators';

const SUCCESS_MESSAGE = 'Successfully';
const NO_CONTENT_STATUS_CODE = 204;
const NOT_MODIFIED_STATUS_CODE = 304;
const SKIP_PATHS = new Set(['/health']);
const SKIP_PREFIXES = ['/documentation'];

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    if (this.shouldBypass(request.path)) {
      return next.handle();
    }

    return next.handle().pipe(
      map((result) => {
        const statusCode = response.statusCode;

        if (this.shouldKeepEmptyBody(statusCode) || this.isEnvelope(result)) {
          return result;
        }

        const { data, message } = this.extractDataAndMessage(result);

        return {
          statusCode,
          data: data ?? null,
          message: message ?? SUCCESS_MESSAGE,
          timestamp: Date.now(),
        };
      }),
    );
  }

  private shouldBypass(path: string): boolean {
    return (
      SKIP_PATHS.has(path) ||
      SKIP_PREFIXES.some((prefix) => path.startsWith(prefix))
    );
  }

  private shouldKeepEmptyBody(statusCode: number): boolean {
    return (
      statusCode === NO_CONTENT_STATUS_CODE ||
      statusCode === NOT_MODIFIED_STATUS_CODE
    );
  }

  private isEnvelope(result: any): boolean {
    return (
      result &&
      typeof result === 'object' &&
      'statusCode' in result &&
      'data' in result &&
      'message' in result &&
      'timestamp' in result
    );
  }

  private extractDataAndMessage(result: any): { data: any; message?: string } {
    if (
      result &&
      typeof result === 'object' &&
      'data' in result &&
      'message' in result
    ) {
      return {
        data: result.data,
        message: result.message,
      };
    }

    return { data: result };
  }
}
