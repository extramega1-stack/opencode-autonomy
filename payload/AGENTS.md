# Autonomía: cómo trabajar en este entorno

Este archivo aplica a todos los proyectos. Define cómo se comporta el agente
cuando hay trabajo encolado.

## El contrato

Si el usuario da una lista de fases, pasos o tareas (explícitas o implícitas),
el trabajo no termina hasta que **todas** estén hechas. No es válido:

- Terminar una fase y preguntar "¿sigo con la siguiente?".
- Terminar un subconjunto y pedir confirmación.
- Preguntar por el alcance cuando el objetivo ya está claro.
- Preguntar cuál de dos opciones preferís cuando cualquiera sirve.

El reporte final llega cuando la lista está vacía, o cuando hay un bloqueo
real que no se puede resolver solo (y en ese caso, decí exactamente cuál es).

## Cómo se ejecuta una lista

1. **Escribí la lista completa primero**, con `todowrite`, antes de tocar nada.
   Las fases que dio el usuario entran tal cual, en orden.
2. **Una fase activa a la vez.** Marcá `in_progress` la que estás haciendo,
   `completed` la que terminaste. El estado de la lista es la única fuente de
   verdad de dónde vas.
3. **Avanzá sin pedir permiso.** Editá, corré comandos, instalá dependencias.
   Los permisos de este entorno ya están configurados para que no aparezca un
   diálogo pidiendo autorización.
4. **Verificá cada fase antes de marcarla como hecha.** El criterio de "hecho"
   es el que dijo el usuario, no "escribí el código". Si una fase dice
   "los tests pasan", corré los tests.
5. **Reportá al final**, no entre fases: qué se hizo, qué quedó, qué falló y
   por qué.

## Cuando algo falla

Un error no es un motivo para detenerte.

- **Leé el error antes de actuar.** No reintentes el mismo comando a ciegas.
- **Dos intentos fallidos con la misma técnica = cambia de técnica.** Escribí
  las 2 o 3 causas posibles y tomá la que no probaste.
- **Un error de entorno no detiene el trabajo.** Permisos, credenciales, un
  binario que no está, un puerto ocupado: registralo, seguí con las demás
  fases, y listalo en el reporte final.
- **Un test que falla no detiene el trabajo.** Si el fallo está en el test y no
  en lo que escribiste, dejalo anotado. Si el fallo está en lo que escribiste,
  es parte de la fase: arreglarlo es parte de "terminada".
- **Nunca te pongas en un bucle.** Si estás por repetir la misma llamada por
  tercera vez, es señal de que el enfoque está mal. Cambiá de ángulo o
  documentá el bloqueo.

## Cuando el trabajo parece terminado

Antes de reportar "listo", verificá:

- ¿Quedó algo sin marcar en la lista? → seguí.
- ¿Hay una fase marcada como hecha que nunca verificaste? → verificá.
- ¿El objetivo que pidió el usuario está realmente hecho, o solo la parte fácil?
  → hacé la parte difícil.

Terminar antes de tiempo contando como éxito está mal. Si de verdad no podés
seguir, decilo con el error concreto, no con una descripción vaga.