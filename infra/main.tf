terraform {
  required_version = ">= 1.5.0"

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
  type    = string
  default = "us-west1"
}

locals {
  runtime_secret_ids = toset([
    "slack-bot-token",
    "slack-signing-secret",
    "gemini-api-key",
  ])

  firestore_index_config = jsondecode(file("${path.module}/firestore.indexes.json"))
  composite_firestore_indexes = {
    for index in local.firestore_index_config.indexes :
    "${index.collectionGroup}-${sha1(jsonencode(index.fields))}" => index
    if length(index.fields) > 1
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

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

resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.apis]
}

resource "google_firestore_index" "composite" {
  for_each = local.composite_firestore_indexes

  project     = var.project_id
  database    = google_firestore_database.default.name
  collection  = each.value.collectionGroup
  query_scope = each.value.queryScope

  dynamic "fields" {
    for_each = each.value.fields

    content {
      field_path   = fields.value.fieldPath
      order        = try(fields.value.order, null)
      array_config = try(fields.value.arrayConfig, null)
    }
  }
}

resource "google_service_account" "anna_lytics" {
  account_id   = "anna-lytics"
  display_name = "Anna Lytics Bot"
}

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

resource "google_project_iam_member" "firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.anna_lytics.email}"
}

resource "google_secret_manager_secret" "runtime" {
  for_each = local.runtime_secret_ids

  secret_id = each.value
  replication { auto {} }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "cloud_run_access" {
  for_each = google_secret_manager_secret.runtime

  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.anna_lytics.email}"
}

resource "google_artifact_registry_repository" "anna_lytics" {
  location      = var.region
  repository_id = "anna-lytics"
  format        = "DOCKER"

  depends_on = [google_project_service.apis]
}
