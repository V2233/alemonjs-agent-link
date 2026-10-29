/** Only explicitly public messages may be returned by administration APIs. */
export class AdminInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminInputError';
  }
}
