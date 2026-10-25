import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CallContext } from '@mondapac-drive/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import {
  AddOwnVehicle,
  ApplyAsCourier,
  ChangeOwnShift,
  DeactivateOwnVehicle,
  DownloadOwnDocument,
  SubmitOwnDocument,
  ViewCourierAppSettings,
  ViewOwnCourierProfile,
} from '../application/use-cases/courier-profile.use-case';
import { courierBody } from './courier-presenter';
import {
  answer,
  DocumentUploadInterceptor,
  fail,
  parsed,
  pathId,
  sendFile,
  type UploadedDocumentFile,
} from './fleet-http';
import { applyBody, documentFields, shiftBody, vehicleBody } from './fleet.schemas';

/**
 * The courier app's fleet API (`Authorization: Bearer <session token>`): the courier applies,
 * reads their own profile and the Market's app settings, keeps their vehicles and documents and
 * changes their shift. The courier is always the session's account, never a path or body field.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@RoutePopulation('courier')
@Controller('fleet/courier')
export class CourierFleetController {
  constructor(
    private readonly apply: ApplyAsCourier,
    private readonly viewProfile: ViewOwnCourierProfile,
    private readonly viewSettings: ViewCourierAppSettings,
    private readonly addVehicle: AddOwnVehicle,
    private readonly deactivateVehicle: DeactivateOwnVehicle,
    private readonly submitDocument: SubmitOwnDocument,
    private readonly downloadDocument: DownloadOwnDocument,
    private readonly changeShift: ChangeOwnShift,
  ) {}

  @Post('me')
  @ReadsSession()
  @ApiOperation({
    summary: 'Apply to deliver in the Market',
    description: 'Idempotent: applying again answers the profile already there (200, not 201).',
  })
  async register(
    @Call() context: CallContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parsed(() => applyBody.parse(body));
    const registered = await answer(() => this.apply.execute(context, input));
    res.status(registered.created ? 201 : 200);
    return courierBody(registered.courier);
  }

  @Get('me')
  @ReadsSession()
  @ApiOperation({
    summary: "The courier's shift and profile",
    description:
      '`{ shift, activeDeliveryId, profile }`. `activeDeliveryId` is the delivery the courier ' +
      "carries now, from delivery's events (assigned until delivered, returned, cancelled or " +
      'unassigned), or null.',
  })
  async me(@Call() context: CallContext, @Res({ passthrough: true }) res: Response) {
    const courier = await answer(() => this.viewProfile.execute(context, {}));
    res.setHeader('Cache-Control', 'no-store');
    return {
      shift: courier.shift,
      activeDeliveryId: courier.activeDeliveryId ?? null,
      profile: courierBody(courier),
    };
  }

  @Get('me/settings')
  @ReadsSession()
  @ApiOperation({ summary: 'The Market settings the courier app runs on' })
  async settings(@Call() context: CallContext, @Res({ passthrough: true }) res: Response) {
    const settings = await answer(() => this.viewSettings.execute(context, {}));
    // Per Market and behind a session: never kept by a shared cache.
    res.setHeader('Cache-Control', 'private, no-store');
    return settings;
  }

  @Put('me/shift')
  @ReadsSession()
  @ApiOperation({
    summary: 'Go online or offline, pause, or start and end a delivery',
    description:
      'Going online needs a vehicle whose required documents are verified and current. Going ' +
      'offline while carrying a delivery answers 409 `fleet.shift.active-delivery`.',
  })
  async shift(@Call() context: CallContext, @Body() body: unknown) {
    const { state } = parsed(() => shiftBody.parse(body));
    const courier = await answer(() => this.changeShift.execute(context, { state }));
    return { shift: courier.shift, activeDeliveryId: courier.activeDeliveryId ?? null };
  }

  @Post('me/vehicles')
  @ReadsSession()
  @ApiOperation({
    summary: 'Add a vehicle',
    description: "A capacity left out is the Market rate card's default for the vehicle type.",
  })
  async vehicle(@Call() context: CallContext, @Body() body: unknown) {
    const input = parsed(() => vehicleBody.parse(body));
    return courierBody(await answer(() => this.addVehicle.execute(context, input)));
  }

  @Post('me/vehicles/:vehicleId/deactivate')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({ summary: 'Take one of the courier’s vehicles out of use' })
  async deactivate(@Call() context: CallContext, @Param('vehicleId') raw: string) {
    const vehicleId = pathId<'Vehicle'>(raw, 'fleet.vehicle.not-found');
    return courierBody(await answer(() => this.deactivateVehicle.execute(context, { vehicleId })));
  }

  @Post('me/documents')
  @ReadsSession()
  @UseInterceptors(DocumentUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Submit a document for review',
    description:
      '`multipart/form-data`: the file in `file` (PDF, JPEG or PNG, at most 10 MB, its type ' +
      'read from the bytes), `type` (the Market’s document code), `vehicleId` for a vehicle ' +
      'document and `expiresAt` for a document that expires.',
  })
  async document(
    @Call() context: CallContext,
    @UploadedFile() file: UploadedDocumentFile | undefined,
    @Body() body: unknown,
  ) {
    if (file === undefined) {
      throw fail(400, 'validation.failed', { fields: [{ path: 'file', code: 'required' }] });
    }
    const fields = parsed(() => documentFields.parse({ ...(body as object) }));
    const submitted = await answer(() =>
      this.submitDocument.execute(context, {
        type: fields.type,
        ...(fields.vehicleId === undefined ? {} : { vehicleId: fields.vehicleId as never }),
        ...(fields.expiresAt === undefined ? {} : { expiresAt: fields.expiresAt }),
        file: file.buffer,
      }),
    );
    return { documentId: submitted.documentId, profile: courierBody(submitted.courier) };
  }

  @Get('me/documents/:documentId/file')
  @ReadsSession()
  @ApiOperation({ summary: 'Download one of the courier’s own documents (as an attachment)' })
  async file(
    @Call() context: CallContext,
    @Param('documentId') raw: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const documentId = pathId<'CourierDocument'>(raw, 'fleet.document.not-found');
    return sendFile(
      res,
      await answer(() => this.downloadDocument.execute(context, { documentId })),
    );
  }
}
