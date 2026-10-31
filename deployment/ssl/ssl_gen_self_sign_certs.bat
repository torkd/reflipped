rem This is not done in the most secure fashion. Only use these certs for private services.
rem This script should be extended like the sh version if Windows deployments are included later.

md %~dp0generated

openssl genrsa -out %~dp0generated\reflipped_multiversal.key


openssl req -x509 -new -subj "/CN=*.wdfp.kakaogames.com" -config reflipped.cnf -key %~dp0generated\reflipped_multiversal.key -days 365 -out %~dp0generated\reflipped_kakao_wdfp_global.crt
openssl req -x509 -new -subj "/CN=openapi-zinny3.game.kakaogames.com" -config reflipped.cnf -key %~dp0generated\reflipped_multiversal.key -days 365 -out %~dp0generated\reflipped_zinny3_openapi.crt
openssl req -x509 -new -subj "/CN=gc-openapi-zinny3.kakaogames.com" -config reflipped.cnf -key %~dp0generated\reflipped_multiversal.key -days 365 -out %~dp0generated\reflipped_zinny3_openapi_gc.crt
openssl req -x509 -new -subj "/CN=gc-infodesk-zinny3.kakaogames.com" -config reflipped.cnf -key %~dp0generated\reflipped_multiversal.key -days 365 -out %~dp0generated\reflipped_zinny3_infodesk_gc.crt

rem This is not normally necessary, but if you need to use HTTPS for reflipped you can use this
rem openssl req -x509 -new -subj "/CN=reflipped.local" -config reflipped.cnf -key %~dp0generated\reflipped_multiversal.key -days 365 -out %~dp0generated\reflipped_local.crt