/** S3 error codes and their HTTP statuses, rendered as S3's XML error body. */
import { xmlDocument, xmlElement } from './xml.js'

const STATUS: Record<string, number> = {
  AccessDenied: 403,
  InvalidAccessKeyId: 403,
  SignatureDoesNotMatch: 403,
  RequestTimeTooSkewed: 403,
  QuotaExceeded: 403,
  AuthorizationHeaderMalformed: 400,
  AuthorizationQueryParametersError: 400,
  InvalidToken: 400,
  ExpiredToken: 400,
  InvalidBucketName: 400,
  InvalidArgument: 400,
  InvalidRequest: 400,
  InvalidPart: 400,
  InvalidPartOrder: 400,
  EntityTooSmall: 400,
  EntityTooLarge: 400,
  MalformedXML: 400,
  XAmzContentSHA256Mismatch: 400,
  BadDigest: 400,
  InvalidDigest: 400,
  IncompleteBody: 400,
  InvalidEncodingType: 400,
  NoSuchBucket: 404,
  NoSuchKey: 404,
  NoSuchUpload: 404,
  MethodNotAllowed: 405,
  BucketAlreadyOwnedByYou: 409,
  BucketNotEmpty: 409,
  OperationAborted: 409,
  PreconditionFailed: 412,
  InvalidRange: 416,
  InvalidMimeType: 415,
  InternalError: 500,
  NotImplemented: 501,
}

/** An S3 protocol error: a code from the S3 API reference plus a human message. */
export class S3Error extends Error {
  readonly status: number
  constructor(
    readonly code: string,
    message: string,
    readonly extra: Record<string, string> = {}
  ) {
    super(message)
    this.status = STATUS[code] ?? 400
  }
}

/** Render an S3Error as S3 does: an XML `<Error>` document (no body for HEAD). */
export function errorResponse(err: S3Error, resource: string, requestId: string, head = false): Response {
  const headers: Record<string, string> = { 'x-amz-request-id': requestId }
  if (head) return new Response(null, { status: err.status, headers })
  const body = xmlDocument(
    'Error',
    [
      xmlElement('Code', err.code),
      xmlElement('Message', err.message),
      ...Object.entries(err.extra).map(([k, v]) => xmlElement(k, v)),
      xmlElement('Resource', resource),
      xmlElement('RequestId', requestId),
    ].join(''),
    false
  )
  headers['content-type'] = 'application/xml'
  return new Response(body, { status: err.status, headers })
}
