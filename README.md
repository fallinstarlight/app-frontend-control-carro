# Frontend web para el control de un vehículo de juguete a través de internet.
Esta aplicación web permite enviar comandos a la API desplegada en una EC2 la cual registra los comandos enviados en una base de datos y ordena a un microcontrolador ESP mover un vehículo dependiendo del comando enviado.

Esta aplicación es completamente estática y funciona meramente a través de AJAX hacia la API en la EC2. El controlador se conecta automáticamente a https://indiscipline-haul-truck.duckdns.org/. En el menú de conexión se puede cambiar el ID del vehículo.

Esta aplicación web está diseñada para trabajar única y exclusivamente con la API diseñada para un vehículo en específico. No funciona con otros vehículos ni implementaciones similares de la API.

La API original puede encontrarse en https://github.com/fallinstarlight/APIs-para-IoT-en-entorno-Dev