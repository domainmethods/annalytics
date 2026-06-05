terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

variable "project_id" {
  type = string
}

variable "region" {
  default = "us-central1"
}

variable "slack_bot_token" {
  type      = string
  sensitive = true
}

variable "slack_signing_secret" {
  type      = string
  sensitive = true
}

variable "gemini_api_key" {
  type      = string
  sensitive = true
}

variable "file_search_store_id" {
  type    = string
  default = ""
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Enable required APIs
resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "firestore.googleapis.com",
    "bigquery.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
  ])
  service = each.value
}

# Firestore database
resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.apis]
}

# Composite Firestore indexes required by state query paths.
resource "google_firestore_index" "response_context_thread_created_at" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "response_context"

  query_scope = "COLLECTION"

  fields {
    field_path = "threadTs"
    order      = "ASCENDING"
  }

  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "response_context_thread_feedback_created_at" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "response_context"

  query_scope = "COLLECTION"

  fields {
    field_path = "threadTs"
    order      = "ASCENDING"
  }

  fields {
    field_path = "negativeFeedback"
    order      = "ASCENDING"
  }

  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "clarification_state_thread_state" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "clarification_state"

  query_scope = "COLLECTION"

  fields {
    field_path = "threadTs"
    order      = "ASCENDING"
  }

  fields {
    field_path = "state"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "escalation_state_original_thread_pipeline_state" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "escalation_state"

  query_scope = "COLLECTION"

  fields {
    field_path = "originalThreadTs"
    order      = "ASCENDING"
  }

  fields {
    field_path = "pipelineState"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "escalation_state_escalation_pipeline_state" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "escalation_state"

  query_scope = "COLLECTION"

  fields {
    field_path = "escalationTs"
    order      = "ASCENDING"
  }

  fields {
    field_path = "pipelineState"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "dbt_run_history_model_started_at" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "dbt_run_history"

  query_scope = "COLLECTION"

  fields {
    field_path = "model"
    order      = "ASCENDING"
  }

  fields {
    field_path = "runStartedAt"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "dbt_run_history_status_started_at" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "dbt_run_history"

  query_scope = "COLLECTION"

  fields {
    field_path = "status"
    order      = "ASCENDING"
  }

  fields {
    field_path = "runStartedAt"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "teaching_candidates_status_generated_at" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "teaching_candidates"

  query_scope = "COLLECTION"

  fields {
    field_path = "status"
    order      = "ASCENDING"
  }

  fields {
    field_path = "generatedAt"
    order      = "DESCENDING"
  }
}

# Service account for Cloud Run
resource "google_service_account" "anna_lytics" {
  account_id   = "anna-lytics"
  display_name = "Anna Lytics Bot"
}

# BigQuery read-only access
resource "google_project_iam_member" "bq_viewer" {
  project = var.project_id
  role    = "roles/bigquery.dataViewer"
  member  = "serviceAccount:${google_service_account.anna_lytics.email}"
}

resource "google_project_iam_member" "bq_job_user" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.anna_lytics.email}"
}

# Firestore access
resource "google_project_iam_member" "firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.anna_lytics.email}"
}

# Secrets
resource "google_secret_manager_secret" "slack_bot_token" {
  secret_id = "slack-bot-token"
  replication { auto {} }
}

resource "google_secret_manager_secret_version" "slack_bot_token" {
  secret      = google_secret_manager_secret.slack_bot_token.id
  secret_data = var.slack_bot_token
}

resource "google_secret_manager_secret" "slack_signing_secret" {
  secret_id = "slack-signing-secret"
  replication { auto {} }
}

resource "google_secret_manager_secret_version" "slack_signing_secret" {
  secret      = google_secret_manager_secret.slack_signing_secret.id
  secret_data = var.slack_signing_secret
}

resource "google_secret_manager_secret" "gemini_api_key" {
  secret_id = "gemini-api-key"
  replication { auto {} }
}

resource "google_secret_manager_secret_version" "gemini_api_key" {
  secret      = google_secret_manager_secret.gemini_api_key.id
  secret_data = var.gemini_api_key
}

# Secret accessor for Cloud Run SA
resource "google_secret_manager_secret_iam_member" "access" {
  for_each  = toset(["slack-bot-token", "slack-signing-secret", "gemini-api-key"])
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.anna_lytics.email}"
}

# Cloud Run service
resource "google_cloud_run_v2_service" "anna_lytics" {
  name     = "anna-lytics"
  location = var.region

  template {
    service_account = google_service_account.anna_lytics.email

    scaling {
      min_instance_count = 1
      max_instance_count = 10
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/anna-lytics/anna-lytics:latest"

      resources {
        limits = {
          cpu    = "2"
          memory = "1Gi"
        }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      env {
        name = "SLACK_BOT_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.slack_bot_token.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "SLACK_SIGNING_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.slack_signing_secret.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "GEMINI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.gemini_api_key.secret_id
            version = "latest"
          }
        }
      }

      env { name = "GCP_PROJECT_ID"; value = var.project_id }
      env { name = "PORT";           value = "3000" }
      env { name = "FILE_SEARCH_STORE_ID"; value = var.file_search_store_id }

      ports { container_port = 3000 }
    }

    timeout = "300s"
    max_instance_request_concurrency = 20
  }
}

# Artifact Registry
resource "google_artifact_registry_repository" "anna_lytics" {
  location      = var.region
  repository_id = "anna-lytics"
  format        = "DOCKER"
}
