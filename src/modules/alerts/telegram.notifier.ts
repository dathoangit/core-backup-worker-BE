import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class TelegramNotifier {
  private readonly logger = new Logger(TelegramNotifier.name);

  async send(options: {
    botToken: string;
    chatId: string;
    text: string;
  }): Promise<void> {
    const { botToken, chatId, text } = options;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.warn(`Telegram send failed: ${response.status} ${body}`);

      throw new Error(`Telegram API ${response.status}`);
    }
  }
}
