import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';

@Injectable()
export class EmailNotifier {
  private readonly logger = new Logger(EmailNotifier.name);

  async send(options: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<void> {
    const transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth:
        options.user && options.password
          ? { user: options.user, pass: options.password }
          : undefined,
    });

    try {
      await transporter.sendMail({
        from: options.from,
        to: options.to,
        subject: options.subject,
        text: options.text,
      });
    } catch (error) {
      this.logger.warn(
        `Email send failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      throw error;
    } finally {
      transporter.close();
    }
  }
}
