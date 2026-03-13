{{- define "ai-voice-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ai-voice-agent.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "ai-voice-agent.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: {{ include "ai-voice-agent.name" . }}
{{- end }}

{{- define "ai-voice-agent.backend.labels" -}}
{{ include "ai-voice-agent.labels" . }}
app.kubernetes.io/name: {{ include "ai-voice-agent.fullname" . }}-backend
app.kubernetes.io/component: backend
{{- end }}

{{- define "ai-voice-agent.frontend.labels" -}}
{{ include "ai-voice-agent.labels" . }}
app.kubernetes.io/name: {{ include "ai-voice-agent.fullname" . }}-frontend
app.kubernetes.io/component: frontend
{{- end }}

{{- define "ai-voice-agent.backend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ai-voice-agent.fullname" . }}-backend
app.kubernetes.io/component: backend
{{- end }}

{{- define "ai-voice-agent.frontend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ai-voice-agent.fullname" . }}-frontend
app.kubernetes.io/component: frontend
{{- end }}
