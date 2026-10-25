import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { CallContext, Id } from '@mondapac-drive/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import {
  ApproveCourier,
  ListCouriers,
  OffboardCourier,
  ReinstateCourier,
  SetCourierTaxRegistration,
  SuspendCourier,
  ViewCourier,
} from '../application/use-cases/operator-couriers.use-case';
import {
  DownloadCourierDocument,
  ListExpiringDocuments,
  RejectCourierDocument,
  RevokeCourierDocument,
  VerifyCourierDocument,
} from '../application/use-cases/operator-documents.use-case';
import {
  DeactivateCourierVehicle,
  SetVehicleCapacity,
} from '../application/use-cases/operator-vehicles.use-case';
import { adminCourierBody, adminCourierSummaryBody } from './courier-presenter';
import { answer, parsed, pathId, sendFile } from './fleet-http';
import {
  approveBody,
  capacityBody,
  courierListQuery,
  expiringDocumentsQuery,
  refuseDocumentBody,
  suspendBody,
  taxRegistrationBody,
  verifyBody,
} from './fleet.schemas';

const DEFAULT_COURIER_PAGE = 50;
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };

const courierIdOf = (raw: string): Id<'Courier'> =>
  pathId<'Courier'>(raw, 'fleet.courier.not-found');
const documentIdOf = (raw: string): Id<'CourierDocument'> =>
  pathId<'CourierDocument'>(raw, 'fleet.document.not-found');
const vehicleIdOf = (raw: string): Id<'Vehicle'> =>
  pathId<'Vehicle'>(raw, 'fleet.vehicle.not-found');

/**
 * The panel's fleet API for operators and dispatchers (the admin session cookie): the Market's
 * couriers with their vehicles and documents, document review and download, and the decisions
 * about a courier's standing, tax registration and vehicles. Every decision is audited. A
 * courier is named by its fleet id; a body also carries the identity account id (`accountId`,
 * for the panel's links and identity's names) and the delivery the courier carries, never a
 * document's storage key.
 */
@ApiTags('fleet')
@RoutePopulation('admin')
@Controller('fleet/admin')
export class AdminFleetController {
  constructor(
    private readonly listCouriers: ListCouriers,
    private readonly viewCourier: ViewCourier,
    private readonly approveCourier: ApproveCourier,
    private readonly suspendCourier: SuspendCourier,
    private readonly reinstateCourier: ReinstateCourier,
    private readonly offboardCourier: OffboardCourier,
    private readonly setTaxRegistration: SetCourierTaxRegistration,
    private readonly verifyDocument: VerifyCourierDocument,
    private readonly rejectDocument: RejectCourierDocument,
    private readonly revokeDocument: RevokeCourierDocument,
    private readonly downloadDocument: DownloadCourierDocument,
    private readonly listExpiringDocuments: ListExpiringDocuments,
    private readonly deactivateVehicle: DeactivateCourierVehicle,
    private readonly setVehicleCapacity: SetVehicleCapacity,
  ) {}

  @Get('couriers')
  @ReadsSession()
  @ApiOperation({
    summary: 'The couriers of the Market, oldest first',
    description:
      `Filter by \`status\`; paged with \`after\` (the \`next\` of the previous page) and ` +
      `\`limit\` (1 to 100, default ${DEFAULT_COURIER_PAGE}). Not cached.`,
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'after', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async list(
    @Call() context: CallContext,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { status, after, limit } = parsed(() => courierListQuery.parse(query));
    const page = await answer(() =>
      this.listCouriers.execute(context, {
        ...(status === undefined ? {} : { status }),
        ...(after === undefined ? {} : { after: after as Id<'Courier'> }),
        limit: limit ?? DEFAULT_COURIER_PAGE,
      }),
    );
    res.setHeader('Cache-Control', 'no-store');
    return { items: page.items.map(adminCourierSummaryBody), next: page.next };
  }

  @Get('documents/expiring')
  @ReadsSession()
  @ApiOperation({
    summary: 'Verified documents that expire before an instant, soonest first',
    description:
      '`before` (an ISO instant: the panel sends now plus its horizon, such as 30 days); paged ' +
      `with \`after\` (the \`next\` of the previous page) and \`limit\` (1 to 100, default ` +
      `${DEFAULT_COURIER_PAGE}). Already expired documents are listed first; offboarded ` +
      'couriers are left out. Not cached.',
  })
  @ApiQuery({ name: 'before', required: true })
  @ApiQuery({ name: 'after', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async expiring(
    @Call() context: CallContext,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { before, after, limit } = parsed(() => expiringDocumentsQuery.parse(query));
    const page = await answer(() =>
      this.listExpiringDocuments.execute(context, {
        before,
        ...(after === undefined ? {} : { after: after as Id<'CourierDocument'> }),
        limit: limit ?? DEFAULT_COURIER_PAGE,
      }),
    );
    res.setHeader('Cache-Control', 'no-store');
    return {
      items: page.items.map((item) => ({
        documentId: item.documentId,
        courierId: item.courierId,
        accountId: item.accountId,
        type: item.type,
        expiresAt: item.expiresAt.toString(),
      })),
      next: page.next,
    };
  }

  @Get('couriers/:courierId')
  @ReadsSession()
  @ApiOperation({ summary: 'A courier with their vehicles and documents' })
  async get(
    @Call() context: CallContext,
    @Param('courierId') raw: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const courierId = courierIdOf(raw);
    const courier = await answer(() => this.viewCourier.execute(context, { courierId }));
    res.setHeader('Cache-Control', 'no-store');
    return adminCourierBody(courier);
  }

  @Post('couriers/:courierId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiHeader(CSRF)
  @ApiOperation({ summary: 'Approve an applicant on the terms the operator confirmed' })
  async approve(
    @Call() context: CallContext,
    @Param('courierId') raw: string,
    @Body() body: unknown,
  ) {
    const courierId = courierIdOf(raw);
    const terms = parsed(() => approveBody.parse(body));
    return adminCourierBody(
      await answer(() => this.approveCourier.execute(context, { courierId, terms })),
    );
  }

  @Post('couriers/:courierId/suspend')
  @HttpCode(200)
  @ReadsSession()
  @ApiHeader(CSRF)
  @ApiOperation({ summary: 'Suspend an active courier (ends their shift)' })
  async suspend(
    @Call() context: CallContext,
    @Param('courierId') raw: string,
    @Body() body: unknown,
  ) {
    const courierId = courierIdOf(raw);
    const { reason } = parsed(() => suspendBody.parse(body));
    return adminCourierBody(
      await answer(() => this.suspendCourier.execute(context, { courierId, reason })),
    );
  }

  @Post('couriers/:courierId/reinstate')
  @HttpCode(200)
  @ReadsSession()
  @ApiHeader(CSRF)
  @ApiOperation({ summary: 'Reinstate a suspended courier who is still eligible' })
  async reinstate(@Call() context: CallContext, @Param('courierId') raw: string) {
    const courierId = courierIdOf(raw);
    return adminCourierBody(
      await answer(() => this.reinstateCourier.execute(context, { courierId })),
    );
  }

  @Post('couriers/:courierId/offboard')
  @HttpCode(200)
  @ReadsSession()
  @ApiHeader(CSRF)
  @ApiOperation({ summary: "End a courier's work for good" })
  async offboard(@Call() context: CallContext, @Param('courierId') raw: string) {
    const courierId = courierIdOf(raw);
    return adminCourierBody(
      await answer(() => this.offboardCourier.execute(context, { courierId })),
    );
  }

  @Put('couriers/:courierId/tax-registration')
  @ReadsSession()
  @ApiHeader(CSRF)
  @ApiOperation({
    summary: "Record whether the courier is registered for the Market's sales tax",
    description: "Payouts adds the Market's sales tax to a registered contractor's earnings.",
  })
  async tax(@Call() context: CallContext, @Param('courierId') raw: string, @Body() body: unknown) {
    const courierId = courierIdOf(raw);
    const { taxRegistered } = parsed(() => taxRegistrationBody.parse(body));
    return adminCourierBody(
      await answer(() => this.setTaxRegistration.execute(context, { courierId, taxRegistered })),
    );
  }

  @Post('couriers/:courierId/documents/:documentId/verify')
  @HttpCode(200)
  @ReadsSession()
  @ApiHeader(CSRF)
  @ApiOperation({
    summary: 'Verify a submitted document',
    description: '`expiresAt`: the expiry read on the document, required when it expires.',
  })
  async verify(
    @Call() context: CallContext,
    @Param('courierId') rawCourier: string,
    @Param('documentId') rawDocument: string,
    @Body() body: unknown,
  ) {
    const courierId = courierIdOf(rawCourier);
    const documentId = documentIdOf(rawDocument);
    const { expiresAt } = parsed(() => verifyBody.parse(body ?? {}));
    return adminCourierBody(
      await answer(() =>
        this.verifyDocument.execute(context, {
          courierId,
          documentId,
          ...(expiresAt === undefined ? {} : { confirmedExpiresAt: expiresAt }),
        }),
      ),
    );
  }

  @Post('couriers/:courierId/documents/:documentId/reject')
  @HttpCode(200)
  @ReadsSession()
  @ApiHeader(CSRF)
  @ApiOperation({ summary: 'Reject a submitted document with a reason code' })
  async reject(
    @Call() context: CallContext,
    @Param('courierId') rawCourier: string,
    @Param('documentId') rawDocument: string,
    @Body() body: unknown,
  ) {
    const courierId = courierIdOf(rawCourier);
    const documentId = documentIdOf(rawDocument);
    const { reason } = parsed(() => refuseDocumentBody.parse(body));
    return adminCourierBody(
      await answer(() => this.rejectDocument.execute(context, { courierId, documentId, reason })),
    );
  }

  @Post('couriers/:courierId/documents/:documentId/revoke')
  @HttpCode(200)
  @ReadsSession()
  @ApiHeader(CSRF)
  @ApiOperation({ summary: 'Revoke a verified document with a reason code' })
  async revoke(
    @Call() context: CallContext,
    @Param('courierId') rawCourier: string,
    @Param('documentId') rawDocument: string,
    @Body() body: unknown,
  ) {
    const courierId = courierIdOf(rawCourier);
    const documentId = documentIdOf(rawDocument);
    const { reason } = parsed(() => refuseDocumentBody.parse(body));
    return adminCourierBody(
      await answer(() => this.revokeDocument.execute(context, { courierId, documentId, reason })),
    );
  }

  @Get('couriers/:courierId/documents/:documentId/file')
  @ReadsSession()
  @ApiOperation({ summary: "Download a courier's document (as an attachment)" })
  async file(
    @Call() context: CallContext,
    @Param('courierId') rawCourier: string,
    @Param('documentId') rawDocument: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const courierId = courierIdOf(rawCourier);
    const documentId = documentIdOf(rawDocument);
    return sendFile(
      res,
      await answer(() => this.downloadDocument.execute(context, { courierId, documentId })),
    );
  }

  @Post('couriers/:courierId/vehicles/:vehicleId/deactivate')
  @HttpCode(200)
  @ReadsSession()
  @ApiHeader(CSRF)
  @ApiOperation({ summary: "Take a courier's vehicle out of use" })
  async deactivate(
    @Call() context: CallContext,
    @Param('courierId') rawCourier: string,
    @Param('vehicleId') rawVehicle: string,
  ) {
    const courierId = courierIdOf(rawCourier);
    const vehicleId = vehicleIdOf(rawVehicle);
    return adminCourierBody(
      await answer(() => this.deactivateVehicle.execute(context, { courierId, vehicleId })),
    );
  }

  @Put('couriers/:courierId/vehicles/:vehicleId/capacity')
  @ReadsSession()
  @ApiHeader(CSRF)
  @ApiOperation({ summary: "Set a vehicle's capacity (weight in grams, volume in litres)" })
  async capacity(
    @Call() context: CallContext,
    @Param('courierId') rawCourier: string,
    @Param('vehicleId') rawVehicle: string,
    @Body() body: unknown,
  ) {
    const courierId = courierIdOf(rawCourier);
    const vehicleId = vehicleIdOf(rawVehicle);
    const capacity = parsed(() => capacityBody.parse(body));
    return adminCourierBody(
      await answer(() =>
        this.setVehicleCapacity.execute(context, { courierId, vehicleId, capacity }),
      ),
    );
  }
}
