import {workbenchOpenApi} from "./training/workbench-openapi";
import {WorkbenchService} from "./training/workbench.service";
import {WorkbenchController} from "./training/workbench.controller";
import {surveyOpenApi} from "./training/survey-openapi";
import {SurveyController} from "./training/survey.controller";
import {SurveyService} from "./training/survey.service";
import {ImportController} from './training/import.controller';
import {importOpenApi} from './training/import-openapi';
import {ImportService} from './training/import.service';
import { KnowledgeController } from "./training/knowledge.controller";
import { KnowledgeService } from "./training/knowledge.service";
import { KnowledgeSourceService } from "./training/knowledge-source.service";
import {phase2OpenApi} from './training/phase2-openapi';
import {TrainingPhase2PublicController} from './training/phase2-public.controller';
import {TrainingPhase2Service} from './training/phase2.service';
import {TrainingReportService} from './training/report.service';
import {CourseworkFilesService} from './training/coursework-files.service';
import { trainingOpenApi } from './training/openapi';
import { SiteService } from './training/site.service';
import { SiteController } from './training/site.controller';
import { TrainingService } from './training/training.service';
import { TrainingAiService } from './training/ai.service';
import { TrainingController } from './training/training.controller';
import "reflect-metadata";
import { Module, ValidationPipe, HttpException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MongooseModule } from "@nestjs/mongoose";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json } from "express";
import type { Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config";
import { Database } from "./database/database";
import { AuthService } from "./auth.service";
import { ApiController } from "./controller";
import { ApiRequest, SafeErrors } from "./errors";
import { dummyHash } from "./security/password";
import { completeOpenApi } from "./openapi";
import { ContentAccess } from "./content/access";
import { ContentService } from "./content/content.service";
import { ContentController } from "./content/content.controller";
import { contentOpenApi } from "./content/content-openapi";
import { FilesService } from "./files/files.service";
import { fileScanEnabled } from "./files/config";
import { FilesController, filesOpenApi } from "./files/files.controller";
import { AssessmentAccess } from "./assessment/access";
import { AssessmentService } from "./assessment/assessment.service";
import { AssessmentController } from "./assessment/assessment.controller";
import { AssessmentFilesController } from "./assessment/assessment-files.controller";
import { assessmentOpenApi } from "./assessment/assessment-openapi";
import { LearningAccess } from "./learning/access";
import { LearningService } from "./learning/learning.service";
import { LearningController } from "./learning/learning.controller";
import { RecommendationsService } from "./learning/recommendations.service";
import { RecommendationsController } from "./learning/recommendations.controller";
import { ReadingService } from "./learning/reading.service";
import { ReadingController } from "./learning/reading.controller";
import { learningOpenApi } from "./learning/learning-openapi";
import { PrivacyService } from "./privacy/privacy.service";
import { PrivacyController } from "./privacy/privacy.controller";
import { privacyOpenApi } from "./privacy/privacy-openapi";
import { TeachingAccess } from "./teaching/access";
import { TeachingService } from "./teaching/teaching.service";
import { TeachingController } from "./teaching/teaching.controller";
import { teachingOpenApi } from "./teaching/teaching-openapi";
import { AdministrationService } from "./administration/administration.service";
import { AdministrationController } from "./administration/administration.controller";
import { extendAdministrationOpenApi } from "./administration/administration-openapi";
import { PlatformBusinessAccess } from "./administration/platform-access";
import { PlatformReportService } from "./administration/report.service";
import { PlatformBusinessController } from "./administration/business.controller";
import { extendPlatformBusinessOpenApi } from "./administration/business-openapi";

export async function createApp(options:{shutdownHooks?:boolean;managedGuard?:(req:ApiRequest,res:Response,next:NextFunction)=>void}={}) {
  fileScanEnabled();
  const config = loadConfig();
  @Module({
    imports: [
      MongooseModule.forRoot(config.mongoUri, {
        autoIndex: false,
        autoCreate: false,
        readPreference: "primary",
        writeConcern: { w: "majority" },
        serverSelectionTimeoutMS: 3000,
        connectTimeoutMS: 3000,
        maxPoolSize: 20,
        retryAttempts: 0,
      }),
    ],
    controllers: [WorkbenchController, SurveyController, ImportController, KnowledgeController, TrainingPhase2PublicController,SiteController, TrainingController, ApiController, ContentController, FilesController, AssessmentController, AssessmentFilesController, LearningController, RecommendationsController, ReadingController, PrivacyController, TeachingController, AdministrationController, PlatformBusinessController],
    providers: [WorkbenchService, SurveyService, ImportService, KnowledgeService, KnowledgeSourceService, TrainingPhase2Service,TrainingReportService, CourseworkFilesService, SiteService, TrainingService, TrainingAiService, Database, AuthService, ContentAccess, ContentService, FilesService, AssessmentAccess, AssessmentService, LearningAccess, LearningService, RecommendationsService, ReadingService, PrivacyService, TeachingAccess, TeachingService, AdministrationService, PlatformBusinessAccess, PlatformReportService],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, {
    logger: false,
    bodyParser: false,
    abortOnError: false,
  });
  try {
    const express = app.getHttpAdapter().getInstance();
    express.disable("x-powered-by");
    express.set("trust proxy", config.trustProxy);
    if(options.managedGuard)app.use(options.managedGuard);
    app.use(
      (
        req: ApiRequest,
        res: Response,
        next: NextFunction,
      ) => {
        req.requestId = randomUUID();
        res.setHeader("X-Request-Id", req.requestId);
        res.setHeader("Cache-Control", "no-store");
        next();
      },
    );
    app.use(helmet());
    const ordinaryJson = json({ limit: "64kb", strict: true });
    const contentJson = json({ limit: "3mb", strict: true });
    const behaviorJson = json({ limit: "2kb", strict: true });
    app.use((req: ApiRequest, res: Response, next: NextFunction) => {
      if (req.method === "POST" && /^\/api\/v1\/(?:behavior-events|privacy\/deletion-requests)\/?$/i.test(req.path)) return behaviorJson(req, res, next);
      const contentPath = /^\/api\/v1\/(?:admin|console\/business\/content\/admin)\/(?:textbook-editions|question-versions)(?:\/|$)/.test(req.path);
      return (contentPath ? contentJson : ordinaryJson)(req, res, next);
    });
    app.use(cookieParser());
    app.useGlobalFilters(new SafeErrors());
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: false,
        validationError: { target: false, value: false },
        exceptionFactory: (errors) => {
          const fields = Object.fromEntries(
            errors.map((error) => [error.property, "字段格式不符合要求"]),
          );
          return new HttpException(
            { code: "VALIDATION_ERROR", message: "请检查请求字段", fields },
            422,
          );
        },
      }),
    );
    if (!config.production) {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle("KnowLadder 身份与内容API")
          .setVersion("2.0.0")
          .addCookieAuth(
            config.secureCookie ? "__Host-kl_session" : "kl_dev_session",
            { type: "apiKey", in: "cookie" },
            "session",
          )
          .build(),
      );
      completeOpenApi(document);
      contentOpenApi(document);
      importOpenApi(document);
      surveyOpenApi(document);
      workbenchOpenApi(document);
      filesOpenApi(document);
      assessmentOpenApi(document);
      learningOpenApi(document);
      privacyOpenApi(document);
      teachingOpenApi(document);
      extendAdministrationOpenApi(document);
      extendPlatformBusinessOpenApi(document);
      trainingOpenApi(document);
  phase2OpenApi(document);
      SwaggerModule.setup("api/docs", app, document, {
        jsonDocumentUrl: "api/openapi.json",
        swaggerOptions: { supportedSubmitMethods: [] },
      });
    }
    await dummyHash();
    await app.init();
    if(options.shutdownHooks !== false) app.enableShutdownHooks();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
