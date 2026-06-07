"use strict";

const liveOpenApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "StreamButed Live Service",
    version: "1.0.0",
    description:
      "Servicio de conciertos en vivo. La API REST administra salas bajo /api/v1/live; el signaling WebRTC usa Socket.IO en /live/ws/socket.io a traves del gateway."
  },
  servers: [
    {
      url: "/",
      description: "Gateway o host actual"
    }
  ],
  tags: [
    {
      name: "Rooms",
      description: "Salas REST protegidas por JWT."
    },
    {
      name: "Signaling",
      description: "Socket.IO autenticado para join/produce/consume sobre WebRTC."
    },
    {
      name: "Health",
      description: "Health checks HTTP."
    }
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Access token emitido por identity-service."
      }
    },
    schemas: {
      ErrorResponse: {
        type: "object",
        required: ["error", "message"],
        properties: {
          error: {
            type: "string",
            example: "VALIDATION_ERROR"
          },
          message: {
            type: "string",
            example: "roomId es obligatorio."
          }
        }
      },
      HealthResponse: {
        type: "object",
        required: ["status", "service"],
        properties: {
          status: {
            type: "string",
            example: "ok"
          },
          service: {
            type: "string",
            example: "live-service"
          }
        }
      },
      Room: {
        type: "object",
        required: ["id", "artistId", "artistName", "title", "status", "listeners", "createdAt"],
        properties: {
          id: {
            type: "string",
            format: "uuid"
          },
          artistId: {
            type: "string"
          },
          artistName: {
            type: "string"
          },
          title: {
            type: "string",
            example: "Concierto acustico"
          },
          status: {
            type: "string",
            enum: ["CREATED", "LIVE", "ENDED"]
          },
          listeners: {
            type: "integer",
            minimum: 0
          },
          createdAt: {
            type: "string",
            format: "date-time"
          }
        }
      },
      RoomListResponse: {
        type: "object",
        required: ["data", "total"],
        properties: {
          data: {
            type: "array",
            items: {
              $ref: "#/components/schemas/Room"
            }
          },
          total: {
            type: "integer",
            minimum: 0
          }
        }
      },
      CreateRoomRequest: {
        type: "object",
        required: ["title"],
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: 120,
            example: "Sesion live de viernes"
          }
        }
      },
      SocketAuthPayload: {
        type: "object",
        required: ["token"],
        properties: {
          token: {
            type: "string",
            description: "JWT enviado como socket.handshake.auth.token."
          }
        }
      }
    },
    responses: {
      Unauthorized: {
        description: "JWT ausente o invalido.",
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/ErrorResponse"
            }
          }
        }
      },
      Forbidden: {
        description: "Rol insuficiente.",
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/ErrorResponse"
            }
          }
        }
      },
      NotFound: {
        description: "Sala no encontrada.",
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/ErrorResponse"
            }
          }
        }
      },
      ValidationError: {
        description: "Datos invalidos.",
        content: {
          "application/json": {
            schema: {
              $ref: "#/components/schemas/ErrorResponse"
            }
          }
        }
      }
    }
  },
  paths: {
    "/api/v1/live/health": {
      get: {
        tags: ["Health"],
        summary: "Health check publico del live-service",
        responses: {
          200: {
            description: "Servicio activo.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/HealthResponse"
                }
              }
            }
          }
        }
      }
    },
    "/api/v1/live/rooms": {
      get: {
        tags: ["Rooms"],
        summary: "Listar salas en vivo",
        security: [{ BearerAuth: [] }],
        responses: {
          200: {
            description: "Salas disponibles.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RoomListResponse"
                }
              }
            }
          },
          401: {
            $ref: "#/components/responses/Unauthorized"
          }
        }
      },
      post: {
        tags: ["Rooms"],
        summary: "Crear sala live para el artista autenticado",
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CreateRoomRequest"
              }
            }
          }
        },
        responses: {
          201: {
            description: "Sala creada.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Room"
                }
              }
            }
          },
          400: {
            $ref: "#/components/responses/ValidationError"
          },
          401: {
            $ref: "#/components/responses/Unauthorized"
          },
          403: {
            $ref: "#/components/responses/Forbidden"
          }
        }
      }
    },
    "/api/v1/live/rooms/{roomId}": {
      get: {
        tags: ["Rooms"],
        summary: "Obtener sala por id",
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: "roomId",
            in: "path",
            required: true,
            schema: {
              type: "string",
              format: "uuid"
            }
          }
        ],
        responses: {
          200: {
            description: "Sala encontrada.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Room"
                }
              }
            }
          },
          400: {
            $ref: "#/components/responses/ValidationError"
          },
          401: {
            $ref: "#/components/responses/Unauthorized"
          },
          404: {
            $ref: "#/components/responses/NotFound"
          }
        }
      }
    },
    "/live/ws/socket.io": {
      get: {
        tags: ["Signaling"],
        summary: "Handshake Socket.IO para signaling WebRTC",
        description:
          "OpenAPI documenta la ubicacion publica del transporte. El cliente envia el JWT como socket.handshake.auth.token y usa los eventos del signalingHandler.",
        responses: {
          101: {
            description: "Upgrade WebSocket aceptado por Socket.IO."
          },
          401: {
            $ref: "#/components/responses/Unauthorized"
          }
        }
      }
    }
  }
};

function renderSwaggerUiHtml(serviceName, initializerPath) {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${serviceName} API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      :root {
        color-scheme: dark;
        --sb-bg: #101417;
        --sb-panel: #171d20;
        --sb-border: #3a454b;
        --sb-text: #f3f7f5;
        --sb-muted: #a8b5b0;
        --sb-accent: #32d296;
        --sb-blue: #62a8ff;
      }
      body { margin: 0; background: var(--sb-bg); }
      .swagger-ui { color: var(--sb-text); font-family: Inter, Segoe UI, Arial, sans-serif; }
      .swagger-ui .topbar { display: none; }
      .swagger-ui .wrapper, .swagger-ui .information-container, .swagger-ui .scheme-container {
        background: var(--sb-bg);
        max-width: none;
        padding-left: 28px;
        padding-right: 28px;
      }
      .swagger-ui .info { margin: 48px 0 36px; }
      .swagger-ui .info .title, .swagger-ui .opblock-tag, .swagger-ui h1, .swagger-ui h2,
      .swagger-ui h3, .swagger-ui h4, .swagger-ui h5, .swagger-ui p, .swagger-ui label,
      .swagger-ui table thead tr td, .swagger-ui table thead tr th,
      .swagger-ui .parameter__name, .swagger-ui .parameter__type,
      .swagger-ui .response-col_status, .swagger-ui .response-col_description,
      .swagger-ui .tab li, .swagger-ui .model-title, .swagger-ui .model,
      .swagger-ui .prop-format, .swagger-ui .servers-title {
        color: var(--sb-text) !important;
      }
      .swagger-ui .info .title small, .swagger-ui .info .base-url, .swagger-ui .markdown p,
      .swagger-ui .opblock-tag small, .swagger-ui .parameter__deprecated,
      .swagger-ui .prop-type { color: var(--sb-muted) !important; }
      .swagger-ui .scheme-container {
        background: var(--sb-panel);
        border: 1px solid var(--sb-border);
        box-shadow: none;
        margin: 0 0 34px;
        padding-top: 24px;
        padding-bottom: 24px;
      }
      .swagger-ui .opblock,
      .swagger-ui .opblock .opblock-section-header,
      .swagger-ui .responses-inner,
      .swagger-ui .opblock-description-wrapper,
      .swagger-ui .parameters-container,
      .swagger-ui .model-box,
      .swagger-ui section.models {
        background: var(--sb-panel);
        border-color: var(--sb-border);
        box-shadow: none;
      }
      .swagger-ui input, .swagger-ui select, .swagger-ui textarea {
        background: #0f1417 !important;
        border-color: #c8d2d8 !important;
        color: var(--sb-text) !important;
      }
      .swagger-ui .btn, .swagger-ui .auth-wrapper .authorize {
        background: transparent;
        border-color: var(--sb-accent);
        color: var(--sb-accent);
      }
      .swagger-ui a, .swagger-ui .info a { color: var(--sb-blue) !important; }
      .swagger-ui .filter .operation-filter-input {
        background: #11171a !important;
        border: 2px solid #c8d2d8 !important;
        color: var(--sb-text) !important;
      }
      .swagger-ui .dialog-ux .modal-ux,
      .swagger-ui .dialog-ux .modal-ux-header,
      .swagger-ui .dialog-ux .modal-ux-content {
        background: var(--sb-panel);
        border-color: var(--sb-border);
        color: var(--sb-text);
      }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
    <script src="${initializerPath}"></script>
  </body>
</html>`;
}

function renderSwaggerUiInitializer(openApiUrl) {
  return `
window.addEventListener("load", () => {
  window.ui = SwaggerUIBundle({
    url: ${JSON.stringify(openApiUrl)},
    dom_id: "#swagger-ui",
    deepLinking: true,
    displayRequestDuration: true,
    filter: true,
    persistAuthorization: true,
    presets: [
      SwaggerUIBundle.presets.apis,
      SwaggerUIStandalonePreset
    ],
    layout: "StandaloneLayout"
  });
});
`;
}

module.exports = {
  liveOpenApiDocument,
  renderSwaggerUiHtml,
  renderSwaggerUiInitializer
};
